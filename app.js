const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const session = require('express-session');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const moment = require('moment-timezone');
const multer = require('multer');
const fs = require('fs');
const compression = require('compression');
const Redis = require('ioredis');
const Queue = require('bull');
const sanitizeHtml = require('sanitize-html');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const OpenAI = require('openai');
const MongoDBStore = require('connect-mongodb-session')(session);

const TRAINING_DATA_FILE = path.join(__dirname, 'training-data.json');
let trainingData = [];
try {
  trainingData = JSON.parse(fs.readFileSync(TRAINING_DATA_FILE, 'utf8'));
} catch {
  trainingData = [];
}

const app = express();
const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client = new MongoClient(uri);
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const emailQueue = new Queue('email-notifications', { redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' } });
const postQueue = new Queue('post-publishing', { redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
const favicon = require('serve-favicon');
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(cookieParser());

// Configuración del store de sesiones
const store = new MongoDBStore({
  uri: process.env.MONGODB_URI,
  collection: 'sessions'
});
store.on('error', (error) => {
  console.error('Error en el store de sesiones:', error);
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'clave-secreta-fuerte',
  resave: false,
  saveUninitialized: false,
  store: store,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true en Render
    maxAge: 30 * 60 * 1000, // 30 minutos de inactividad
    httpOnly: true
  }
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'public/uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|mp4|webm/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Solo se permiten imágenes y videos (JPEG, PNG, GIF, MP4, WebM)'));
  }
});

const resourceUpload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'video/mp4'
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Formato de archivo no permitido'));
  }
});

const { body, validationResult } = require('express-validator');

// Validation middleware for form creation
const validateForm = [
  body('name').trim().notEmpty().withMessage('El nombre del formulario es obligatorio').isLength({ max: 100 }).withMessage('El nombre no puede exceder los 100 caracteres'),
  body('course').trim().notEmpty().withMessage('El curso es obligatorio').isIn(['ingles', 'frances', 'aleman', 'italiano']).withMessage('Curso inválido'),
  body('description').trim().isLength({ max: 500 }).withMessage('La descripción no puede exceder los 500 caracteres'),
  body('active').toBoolean().isBoolean().withMessage('El estado activo debe ser un booleano'),
  body('fields').isArray().withMessage('Los campos deben ser un arreglo'),
  body('fields.*.type').isIn(['text', 'email', 'tel', 'date', 'select', 'radio', 'checkbox', 'number', 'file', 'textarea']).withMessage('Tipo de campo inválido'),
  body('fields.*.label').trim().notEmpty().withMessage('La etiqueta del campo es obligatoria').isLength({ max: 50 }).withMessage('La etiqueta no puede exceder los 50 caracteres'),
  body('fields.*.required').isBoolean().withMessage('El campo requerido debe ser un booleano'),
  body('fields.*.placeholder').optional().trim().isLength({ max: 100 }).withMessage('El placeholder no puede exceder los 100 caracteres'),
  body('fields.*.options').if((value, { req }) => ['select', 'radio', 'checkbox'].includes(req.body.fields[req.path.split('/').pop()]?.type)).isArray({ min: 1 }).withMessage('Las opciones son obligatorias para select, radio o checkbox'),
];

// Validation middleware for form submissions
const validateFormSubmission = [
  body('formId').trim().notEmpty().withMessage('El ID del formulario es obligatorio').isMongoId().withMessage('ID de formulario inválido'),
  body('responses').custom(value => Array.isArray(value)).withMessage('Las respuestas deben ser un arreglo'),
  body('responses.*.fieldId').trim().notEmpty().withMessage('El ID del campo es obligatorio'),
  body('responses.*.value').trim().notEmpty().withMessage('El valor del campo es obligatorio'),
  body('responses.*.value').if((value, { req }) => req.body.responses.some(r => r.type === 'email')).isEmail().withMessage('Correo electrónico inválido'),
  body('responses.*.value').if((value, { req }) => req.body.responses.some(r => r.type === 'tel')).matches(/^\+?\d{10,15}$/).withMessage('Número de teléfono inválido'),
  body('responses.*.value').if((value, { req }) => {
    const response = req.body.responses.find(r => r.type === 'number' && r.label && r.label.toLowerCase().includes('línea de captura'));
    return response && response.value === value;
  }).matches(/^\d{27}$/).withMessage('La línea de captura debe tener exactamente 27 dígitos'),
  body('responses.*.value').if((value, { req }) => {
    const response = req.body.responses.find(r => r.type === 'number' && r.label && r.label.toLowerCase().includes('número de control'));
    return response && response.value === value;
  }).matches(/^\d{9}$/).withMessage('El número de control debe tener exactamente 9 dígitos'),
  body('responses.*.value').if((value, { req }) => {
    const response = req.body.responses.find(r => r.type === 'number' && (!r.label || (!r.label.toLowerCase().includes('línea de captura') && !r.label.toLowerCase().includes('número de control'))));
    return response && response.value === value;
  }).matches(/^\d{1,10}$/).withMessage('El valor numérico debe tener entre 1 y 10 dígitos'),
];

let db;

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

function requireAuth(req, res, next) {
  if (req.session.user) next();
  else res.redirect('/login.html');
}

const restrictedPages = [
  '/crear_calendario', '/editar_events', '/dashboard', '/crear_form',
  '/editor', '/crear_post', '/editar_posts', '/editar_forms', '/editar_resources', '/dashboard_documentos',
  '/dashboard_pagos', '/perfil', '/subir_recurso', '/chat'
];

app.use((req, res, next) => {
  const requestedPath = req.path;
  if (restrictedPages.includes(requestedPath)) requireAuth(req, res, next);
  else next();
});

// Rutas dinámicas para páginas protegidas
app.get('/crear_calendario', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'crear_calendario.html'));
});
app.get('/editar_events', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'editar_events.html'));
});
app.get('/editor.js', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.js'));
});
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'dashboard.html'));
});
app.get('/crear_form', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'crear_form.html'));
});
app.get('/editor', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'editor.html'));
});
app.get('/crear_post', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'crear_post.html'));
});
app.get('/editar_posts', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'editar_posts.html'));
});
app.get('/editar_forms', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'editar_forms.html'));
});
app.get('/editar_resources', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'editar_resources.html'));
});
app.get('/dashboard_documentos', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'dashboard_documentos.html'));
});
app.get('/dashboard_pagos', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'dashboard_pagos.html'));
});
app.get('/perfil', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'perfil.html'));
});
app.get('/subir_recurso', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'subir_recurso.html'));
});
app.get('/chat', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'chat.html'));
});

async function connect() {
  try {
    await client.connect();
    console.log('Conectado a MongoDB');
    db = client.db('livetext');
    await ensureCollections(db);
    await ensureIndexes(db);
    return db;
  } catch (error) {
    console.error('Error al conectar a MongoDB:', error);
    process.exit(1);
  }
}

async function ensureCollections(db) {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);
  const requiredCollections = [
    'users', 'codigos', 'resetTokens', 'notificationsQueue',
    'calendar_events', 'posts', 'resources', 'newsletter_subscribers', 'forms', 'comments', 'documents', 'templates'
  ];
  for (const name of requiredCollections) {
    if (!collectionNames.includes(name)) await db.createCollection(name);
  }
  await db.collection('newsletter_subscribers').createIndex({ email: 1 }, { unique: true });
  await db.collection('comments').createIndex({ postId: 1, createdAt: -1 });
}

async function ensureIndexes(db) {
  await db.collection('posts').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('posts').createIndex({ isPublic: 1, date: -1 });
  await db.collection('calendar_events').createIndex({ userId: 1, start: -1 });
  await db.collection('forms').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('resources').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('posts').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('forms').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('form_submissions').createIndex({ formId: 1, createdAt: -1 });
  await db.collection('form_submissions').createIndex({ 'responses.fieldId': 1, 'responses.value': 1 }); // For email uniqueness
  await db.collection('templates').createIndex({ userId: 1, createdAt: -1 });
}

async function registerUser(db, userData) {
  const { name, surname, secondSurname, email, password, confirmPassword, code } = userData;
  if (!/^[a-zA-Z\s]+$/.test(name) || !/^[a-zA-Z\s]+$/.test(surname) || !/^[a-zA-Z\s]+$/.test(secondSurname)) {
    throw new Error('El nombre y apellidos solo deben contener letras y espacios.');
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('El correo electrónico no tiene un formato válido.');
  const existingUser = await db.collection('users').findOne({ email });
  if (existingUser) throw new Error('El correo ya está en uso.');
  if (!/^(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d]{8,}$/.test(password)) throw new Error('La contraseña debe tener al menos 8 caracteres con letras y números.');
  if (password !== confirmPassword) throw new Error('Las contraseñas no coinciden.');
  const codeDoc = await db.collection('codigos').findOne({ code, available: true });
  if (!codeDoc) throw new Error('Código inválido o ya utilizado.');
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);
  const user = { name, surname, secondSurname, email, password: hashedPassword, createdAt: new Date(), subscribed: false, notificationTypes: [] };
  await db.collection('users').insertOne(user);
  await db.collection('codigos').updateOne({ code }, { $set: { available: false } });
  return user;
}

async function loginUser(db, email, password) {
  const user = await db.collection('users').findOne({ email });
  if (!user) throw new Error('Usuario no encontrado.');
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error('Contraseña incorrecta.');
  return user;
}

async function forgotPassword(db, email) {
  const user = await db.collection('users').findOne({ email });
  if (!user) throw new Error('No se encontró un usuario con ese correo.');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 3600000);
  await db.collection('resetTokens').insertOne({ email, token, expires });
  emailQueue.add({
    from: 'no-reply@livetextweb.com',
    to: email,
    subject: 'Restablecer tu contraseña - LIVETEXT',
    html: `Restablecer contraseña
Hola, ${user.name},
Recibimos una solicitud para restablecer tu contraseña. Haz clic en el siguiente enlace:
<a href="http://localhost:3000/reset-password/${token}">Restablecer contraseña</a>
Este enlace expirará en 1 hora.
Si no solicitaste este cambio, ignora este correo.
Saludos,
Equipo LIVETEXT
`
  });
  return 'Correo de recuperación enviado exitosamente.';
}

async function resetPassword(db, token, newPassword, confirmPassword) {
  if (!/^(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d]{8,}$/.test(newPassword)) throw new Error('La contraseña debe tener al menos 8 caracteres con letras y números.');
  if (newPassword !== confirmPassword) throw new Error('Las contraseñas no coinciden.');
  const tokenDoc = await db.collection('resetTokens').findOne({ token, expires: { $gt: new Date() } });
  if (!tokenDoc) throw new Error('El enlace de recuperación es inválido o ha expirado.');
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(newPassword, salt);
  await db.collection('users').updateOne({ email: tokenDoc.email }, { $set: { password: hashedPassword } });
  await db.collection('resetTokens').deleteOne({ token });
  return 'Contraseña restablecida exitosamente.';
}

async function subscribeNewsletter(db, userData) {
  const { name, email, notificationTypes } = userData;
  if (!/^[a-zA-Z\s]+$/.test(name)) throw new Error('El nombre solo debe contener letras y espacios.');
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('El correo electrónico no tiene un formato válido.');
  const existingSubscriber = await db.collection('newsletter_subscribers').findOne({ email });
  if (existingSubscriber) {
    await db.collection('newsletter_subscribers').updateOne({ email }, { $set: { name, notificationTypes, subscribed: true } });
  } else {
    const subscriber = { name, email, subscribed: true, notificationTypes, createdAt: new Date() };
    await db.collection('newsletter_subscribers').insertOne(subscriber);
  }
  emailQueue.add({
    from: 'no-reply@livetextweb.com',
    to: email,
    subject: 'Bienvenido al boletín de LIVETEXT',
    html: `Bienvenido ${name},<br>Comenzarás a recibir notificaciones de nuevas publicaciones y eventos.`
  });
  return { message: 'Suscripción a notificaciones exitosa.' };
}

async function unsubscribeNewsletter(db, email) {
  const subscriber = await db.collection('newsletter_subscribers').findOne({ email });
  if (!subscriber) throw new Error('No se encontró un usuario con ese correo en el boletín.');
  await db.collection('newsletter_subscribers').updateOne({ email }, { $set: { subscribed: false, notificationTypes: [] } });
  return { message: 'Te has dado de baja exitosamente.' };
}

async function createEvent(db, eventData, userId) {
  const { type, title, course, date, startTime, endTime, location, instructor, description, isRecurring, recurrenceDays, recurrenceEnd, color } = eventData;
  if (!date || !startTime || !endTime) throw new Error('Fecha, hora de inicio y hora de fin son obligatorios.');
  const startDateTime = moment.tz(`${date} ${startTime}`, 'YYYY-MM-DD HH:mm', 'America/Mexico_City').toDate();
  const endDateTime = moment.tz(`${date} ${endTime}`, 'YYYY-MM-DD HH:mm', 'America/Mexico_City').toDate();
  if (!moment(startDateTime).isValid() || !moment(endDateTime).isValid()) throw new Error('Formato de fecha u hora inválido.');
  if (startDateTime >= endDateTime) throw new Error('La hora de inicio debe ser anterior a la hora de fin.');
  const eventToInsert = {
    type,
    title,
    course,
    start: startDateTime,
    end: endDateTime,
    location,
    instructor,
    description,
    color: color || '#e67e22',
    createdAt: new Date(),
    isPublic: true,
    isRecurring: isRecurring || false,
    recurrenceDays: isRecurring ? recurrenceDays : [],
    recurrenceEnd: isRecurring && recurrenceEnd ? moment.tz(recurrenceEnd, 'YYYY-MM-DD', 'America/Mexico_City').toDate() : null,
    userId: new ObjectId(userId)
  };
  const result = await db.collection('calendar_events').insertOne(eventToInsert);
  await redis.del('events:cache');
  const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['events'] } }).toArray();
  for (const subscriber of subscribers) {
    emailQueue.add({
      from: 'no-reply@livetextweb.com',
      to: subscriber.email,
      subject: `Nuevo evento: ${title}`,
      html: `Nuevo Evento
Hola, ${subscriber.name},
Se ha creado un nuevo evento: ${title}
Fecha: ${moment.tz(startDateTime, 'America/Mexico_City').format('LLL')} - ${moment.tz(endDateTime, 'America/Mexico_City').format('LT')}
<a href="http://localhost:3000/index.html#event-${result.insertedId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
    });
  }
  return { message: 'Evento creado exitosamente.', insertedId: result.insertedId };
}

async function getEvents(db) {
  const cacheKey = 'events:cache';
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const events = await db.collection('calendar_events').find({ isPublic: true }).toArray();
  const formattedEvents = events.map(event => ({
    ...event,
    start: moment.tz(event.start, 'America/Mexico_City').toDate(),
    end: moment.tz(event.end, 'America/Mexico_City').toDate()
  }));
  await redis.setex(cacheKey, 300, JSON.stringify(formattedEvents));
  return formattedEvents;
}

async function updateEvent(db, eventId, eventData, userId) {
  const { type, title, course, start, end, location, instructor, description, isRecurring, recurrenceDays, recurrenceEnd } = eventData;
  const updateData = {
    type,
    title,
    course,
    start: start ? moment.tz(start, 'America/Mexico_City').toDate() : undefined,
    end: end ? moment.tz(end, 'America/Mexico_City').toDate() : undefined,
    location,
    instructor,
    description,
    isRecurring: isRecurring || false,
    recurrenceDays: isRecurring ? recurrenceDays : [],
    recurrenceEnd: isRecurring && recurrenceEnd ? moment.tz(recurrenceEnd, 'YYYY-MM-DD', 'America/Mexico_City').toDate() : null,
    updatedAt: new Date()
  };
  const result = await db.collection('calendar_events').updateOne(
    { _id: new ObjectId(eventId), userId: new ObjectId(userId) },
    { $set: updateData }
  );
  if (result.matchedCount === 0) throw new Error('Evento no encontrado o no tienes permisos.');
  await redis.del('events:cache');
  const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['events'] } }).toArray();
  for (const subscriber of subscribers) {
    emailQueue.add({
      from: 'no-reply@livetextweb.com',
      to: subscriber.email,
      subject: `Evento actualizado: ${title}`,
      html: `Evento Actualizado
Hola, ${subscriber.name},
Se ha actualizado el evento: ${title}
Fecha: ${moment.tz(start, 'America/Mexico_City').format('LLL')} - ${moment.tz(end, 'America/Mexico_City').format('LT')}
<a href="http://localhost:3000/index.html#event-${eventId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
    });
  }
  return { message: 'Evento actualizado exitosamente.' };
}

async function deleteEvent(db, eventId, userId) {
  const result = await db.collection('calendar_events').deleteOne({ 
    _id: new ObjectId(eventId),
    userId: new ObjectId(userId)
  });
  if (result.deletedCount === 0) throw new Error('Evento no encontrado o no tienes permisos.');
  await redis.del('events:cache');
  return { message: 'Evento eliminado exitosamente.' };
}

async function createResource(db, resourceData, files, userId) {
  const { title, description = '', category } = resourceData;
  if (!title) throw new Error('El título es obligatorio.');
  const resource = {
    title: title.trim(),
    description: sanitizeHtml(description || ''),
    category,
    userId: new ObjectId(userId),
    createdAt: new Date(),
    isPublic: true
  };
  if (files && files.length > 0) {
    resource.files = files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      path: `/uploads/${file.filename}`,
      contentType: file.mimetype
    }));
  }
  const result = await db.collection('resources').insertOne(resource);
  await redis.del('resources:cache');
  const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['resources'] } }).toArray();
  for (const subscriber of subscribers) {
    emailQueue.add({
      from: 'no-reply@livetextweb.com',
      to: subscriber.email,
      subject: `Nuevo recurso: ${title}`,
      html: `Nuevo Recurso
Hola, ${subscriber.name},
Se ha publicado un nuevo recurso: ${title}
Categoría: ${category}
<a href="http://localhost:3000/index.html#resource-${result.insertedId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
    });
  }
  return { message: 'Recurso creado exitosamente.', insertedId: result.insertedId };
}

function parseBool(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

async function createPost(db, postData, files, userId, isDraft = false) {
  console.log('Creating post:', postData, files);
  const { title, content, category, allowComments, mediaMode, tags, date, time, schedulePost } = postData;
  if (!title || !content) throw new Error('Título y contenido son obligatorios.');
  const wordCount = content.trim().split(/\s+/).length;
  if (wordCount > 400) throw new Error('El contenido excede el límite de 400 palabras.');
  const sanitizedContent = sanitizeHtml(content, {
    allowedTags: ['b', 'i', 'u', 'p', 'br'],
    allowedAttributes: {}
  });
  const now = moment.tz('America/Mexico_City').toDate();
  const schedule = parseBool(schedulePost);
  let postDateTime = now;
  if (schedule && date && time) {
    postDateTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', 'America/Mexico_City').toDate();
    if (!moment(postDateTime).isValid()) throw new Error('Formato de fecha u hora inválido.');
    if (!isDraft && postDateTime < now) throw new Error('No puedes programar una publicación en el pasado.');
  } else if (schedule) {
    throw new Error('Fecha y hora son obligatorios cuando se programa la publicación.');
  }
  const post = {
    title: title.trim(),
    content: sanitizedContent,
    category,
    allowComments: parseBool(allowComments),
    mediaMode: mediaMode || 'auto',
    tags: tags ? tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [],
    date: postDateTime,
    userId: new ObjectId(userId),
    createdAt: new Date(),
    updatedAt: new Date(),
    isPublic: !isDraft && postDateTime <= now
  };
  if (files && files.length > 0) {
    post.media = files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      path: `/uploads/${file.filename}`,
      contentType: file.mimetype
    }));
  }
  try {
    const result = await db.collection('posts').insertOne(post);
    await redis.del('posts:cache');
    if (!isDraft && postDateTime > now) {
      await postQueue.add(
        { postId: result.insertedId },
        { delay: postDateTime.getTime() - now.getTime() }
      );
    } else if (!isDraft) {
      const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['posts'] } }).toArray();
      for (const subscriber of subscribers) {
        emailQueue.add({
          from: 'no-reply@livetextweb.com',
          to: subscriber.email,
          subject: `Nueva publicación: ${title}`,
          html: `Nueva Publicación
Hola, ${subscriber.name},
Se ha creado una nueva publicación: ${title}
Fecha: ${moment.tz(postDateTime, 'America/Mexico_City').format('LLL')}
<a href="http://localhost:3000/index.html#post-${result.insertedId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
        });
      }
    }
    return { message: `Publicación ${isDraft ? 'guardada como borrador' : 'creada'} exitosamente.`, insertedId: result.insertedId };
  } catch (error) {
    console.error('Error in createPost:', error.stack);
    if (error instanceof multer.MulterError) {
      throw new Error(`Error de archivo: ${error.message} (Límite: 50MB)`);
    }
    throw error;
  }
}

async function updatePost(db, postId, postData, files, userId, isDraft = false) {
  console.log('Updating post:', postId, postData, files);
  const { title, content, category, allowComments, mediaMode, tags, date, time, schedulePost } = postData;
  const wordCount = content.trim().split(/\s+/).length;
  if (wordCount > 400) throw new Error('El contenido excede el límite de 400 palabras.');
  const sanitizedContent = sanitizeHtml(content, {
    allowedTags: ['b', 'i', 'u', 'p', 'br'],
    allowedAttributes: {}
  });
  const now = moment.tz('America/Mexico_City').toDate();
  const schedule = parseBool(schedulePost);
  let postDateTime = now;
  if (schedule && date && time) {
    postDateTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', 'America/Mexico_City').toDate();
    if (!moment(postDateTime).isValid()) throw new Error('Formato de fecha u hora inválido.');
    if (!isDraft && postDateTime < now) throw new Error('No puedes programar una publicación en el pasado.');
  } else if (schedule) {
    throw new Error('Fecha y hora son obligatorios cuando se programa la publicación.');
  }
  const updateData = {
    title: title.trim(),
    content: sanitizedContent,
    category,
    allowComments: parseBool(allowComments),
    mediaMode: mediaMode || 'auto',
    tags: tags ? tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [],
    date: postDateTime,
    updatedAt: new Date(),
    isPublic: !isDraft && postDateTime <= now
  };
  if (files && files.length > 0) {
    updateData.media = files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      path: `/uploads/${file.filename}`,
      contentType: file.mimetype
    }));
  }
  try {
    const result = await db.collection('posts').updateOne(
      { _id: new ObjectId(postId), userId: new ObjectId(userId) },
      { $set: updateData }
    );
    if (result.matchedCount === 0) throw new Error('Publicación no encontrada o no tienes permisos.');
    await redis.del('posts:cache');
    await redis.del(`post:${postId}`);
    if (!isDraft && postDateTime > now) {
      await postQueue.add(
        { postId },
        { delay: postDateTime.getTime() - now.getTime() }
      );
    } else if (!isDraft) {
      const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['posts'] } }).toArray();
      for (const subscriber of subscribers) {
        emailQueue.add({
          from: 'no-reply@livetextweb.com',
          to: subscriber.email,
          subject: `Publicación actualizada: ${title}`,
          html: `Publicación Actualizada
Hola, ${subscriber.name},
Se ha actualizado la publicación: ${title}
Fecha: ${moment.tz(postDateTime, 'America/Mexico_City').format('LLL')}
<a href="http://localhost:3000/index.html#post-${postId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
        });
      }
    }
    return { message: `Publicación ${isDraft ? 'guardada como borrador' : 'actualizada'} exitosamente.` };
  } catch (error) {
    console.error('Error in updatePost:', error.stack);
    if (error instanceof multer.MulterError) {
      throw new Error(`Error de archivo: ${error.message} (Límite: 50MB)`);
    }
    throw error;
  }
}

async function deletePost(db, postId, userId) {
  const result = await db.collection('posts').deleteOne({ 
    _id: new ObjectId(postId),
    userId: new ObjectId(userId)
  });
  if (result.deletedCount === 0) throw new Error('Publicación no encontrada o no tienes permisos.');
  await db.collection('comments').deleteMany({ postId: new ObjectId(postId) });
  await redis.del('posts:cache');
  await redis.del(`post:${postId}`);
  return { message: 'Publicación eliminada exitosamente.' };
}

async function getPosts(db, page = 1, limit = 10, category = null) {
  const cacheKey = `posts:cache:${page}:${limit}:${category || 'all'}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const query = { isPublic: true };
  if (category) query.category = category;
  const posts = await db.collection('posts')
    .find(query)
    .sort({ date: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();
  const formattedPosts = posts.map(post => ({
    ...post,
    createdAt: moment.tz(post.createdAt, 'America/Mexico_City').toDate(),
    date: moment.tz(post.date, 'America/Mexico_City').toDate()
  }));
  await redis.setex(cacheKey, 300, JSON.stringify(formattedPosts));
  return formattedPosts;
}

async function getPost(db, postId) {
  const cacheKey = `post:${postId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const post = await db.collection('posts').findOne({ _id: new ObjectId(postId), isPublic: true });
  if (!post) throw new Error('Publicación no encontrada.');
  const formattedPost = {
    ...post,
    createdAt: moment.tz(post.createdAt, 'America/Mexico_City').toDate(),
    date: moment.tz(post.date, 'America/Mexico_City').toDate()
  };
  await redis.setex(cacheKey, 300, JSON.stringify(formattedPost));
  return formattedPost;
}

async function createForm(db, formData, userId) {
  const { title, description, active = true, createdAt = new Date() } = formData;
  const activeBool = active === true || active === 'true';
  const form = {
    title,
    description,
    createdAt,
    isPublic: activeBool,
    status: activeBool ? 'published' : 'draft',
    userId: new ObjectId(userId)
  };
  const result = await db.collection('forms').insertOne(form);
  await redis.del('forms:cache');
  const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['forms'] } }).toArray();
  for (const subscriber of subscribers) {
    emailQueue.add({
      from: 'no-reply@livetextweb.com',
      to: subscriber.email,
      subject: `Nuevo formulario: ${title}`,
      html: `Nuevo Formulario
Hola, ${subscriber.name},
Se ha publicado un nuevo formulario: ${title}
<a href="http://localhost:3000/index.html#form-${result.insertedId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
    });
  }
  return { message: 'Formulario creado exitosamente.', insertedId: result.insertedId };
}

async function getForms(db, page = 1, limit = 10) {
  const cacheKey = `forms:cache:${page}:${limit}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const forms = await db.collection('forms')
    .find({ isPublic: true })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();
  const formattedForms = forms.map(form => ({
    ...form,
    createdAt: moment.tz(form.createdAt, 'America/Mexico_City').toDate()
  }));
  await redis.setex(cacheKey, 300, JSON.stringify(formattedForms));
  return formattedForms;
}

async function updateForm(db, formId, formData, userId) {
  const { title, description } = formData;
  const updateData = { title, description, updatedAt: new Date() };
  const result = await db.collection('forms').updateOne(
    { _id: new ObjectId(formId), userId: new ObjectId(userId) },
    { $set: updateData }
  );
  if (result.matchedCount === 0) throw new Error('Formulario no encontrado o no tienes permisos.');
  await redis.del('forms:cache');
  const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['forms'] } }).toArray();
  for (const subscriber of subscribers) {
    emailQueue.add({
      from: 'no-reply@livetextweb.com',
      to: subscriber.email,
      subject: `Formulario actualizado: ${title}`,
      html: `Formulario Actualizado
Hola, ${subscriber.name},
Se ha actualizado el formulario: ${title}
<a href="http://localhost:3000/index.html#form-${formId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
    });
  }
  return { message: 'Formulario actualizado exitosamente.' };
}

async function updateProfile(db, userId, profileData) {
  const { name, surname, secondSurname, email, password, confirmPassword } = profileData;
  if (!/^[a-zA-Z\s]+$/.test(name) || !/^[a-zA-Z\s]+$/.test(surname) || !/^[a-zA-Z\s]+$/.test(secondSurname)) {
    throw new Error('El nombre y apellidos solo deben contener letras y espacios.');
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('El correo electrónico no tiene un formato válido.');
  const existingUser = await db.collection('users').findOne({ email, _id: { $ne: new ObjectId(userId) } });
  if (existingUser) throw new Error('El correo ya está en uso por otro usuario.');
  let updateData = { name, surname, secondSurname, email };
  if (password && confirmPassword) {
    if (!/^(?=.[a-zA-Z])(?=.\d)[a-zA-Z\d]{8,}$/.test(password)) {
      throw new Error('La contraseña debe tener al menos 8 caracteres con letras y números.');
    }
    if (password !== confirmPassword) throw new Error('Las contraseñas no coinciden.');
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    updateData.password = hashedPassword;
  }
  const result = await db.collection('users').updateOne(
    { _id: new ObjectId(userId) },
    { $set: updateData }
  );
  if (result.matchedCount === 0) throw new Error('Usuario no encontrado.');
  const updatedUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
  return updatedUser;
}

async function deleteForm(db, formId, userId) {
  const result = await db.collection('forms').deleteOne({ 
    _id: new ObjectId(formId),
    userId: new ObjectId(userId)
  });
  if (result.deletedCount === 0) throw new Error('Formulario no encontrado o no tienes permisos.');
  await redis.del('forms:cache');
  return { message: 'Formulario eliminado exitosamente.' };
}

async function createComment(db, postId, commentData, visitorId) {
  const { content } = commentData;
  if (!content) throw new Error('El comentario no puede estar vacío.');
  const sanitizedContent = sanitizeHtml(content, {
    allowedTags: [],
    allowedAttributes: {}
  });
  const comment = {
    postId: new ObjectId(postId),
    visitorId,
    content: sanitizedContent,
    createdAt: new Date()
  };
  const result = await db.collection('comments').insertOne(comment);
  await redis.del(`comments:${postId}`);
  return { message: 'Comentario creado exitosamente.', insertedId: result.insertedId };
}

async function getComments(db, postId) {
  const cacheKey = `comments:${postId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const comments = await db.collection('comments')
    .find({ postId: new ObjectId(postId) })
    .sort({ createdAt: -1 })
    .toArray();
  await redis.setex(cacheKey, 300, JSON.stringify(comments));
  return comments;
}

// Resource helpers
async function getResources(db, page = 1, limit = 10) {
  return db.collection('resources')
    .find()
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();
}

async function getResource(db, id) {
  return db.collection('resources').findOne({ _id: new ObjectId(id) });
}

async function updateResource(db, id, data, files, userId) {
  const update = {
    title: data.title,
    description: sanitizeHtml(data.description || ''),
    updatedAt: new Date()
  };
  if (files && files.length > 0) {
    update.files = files.map(f => ({
      filename: f.filename,
      originalname: f.originalname,
      path: `/uploads/${f.filename}`,
      contentType: f.mimetype
    }));
  }
  const result = await db.collection('resources').updateOne(
    { _id: new ObjectId(id), userId: new ObjectId(userId) },
    { $set: update }
  );
  if (result.matchedCount === 0) throw new Error('Recurso no encontrado o no tienes permisos.');
  await redis.del('resources:cache');
  const subscribers = await db
    .collection('newsletter_subscribers')
    .find({ subscribed: true, notificationTypes: { $in: ['resources'] } })
    .toArray();
  for (const subscriber of subscribers) {
    emailQueue.add({
      from: 'no-reply@livetextweb.com',
      to: subscriber.email,
      subject: `Recurso actualizado: ${update.title}`,
      html: `Recurso Actualizado
Hola, ${subscriber.name},
Se ha actualizado el recurso: ${update.title}
<a href="http://localhost:3000/index.html#resource-${id}">Ver detalles</a>
Saludos,
Equipo LIVETEXT`
    });
  }
  return { message: 'Recurso actualizado exitosamente.' };
}

async function deleteResource(db, id, userId) {
  const result = await db.collection('resources').deleteOne({
    _id: new ObjectId(id),
    userId: new ObjectId(userId)
  });
  if (result.deletedCount === 0) throw new Error('Recurso no encontrado o no tienes permisos.');
  await redis.del('resources:cache');
  return { message: 'Recurso eliminado exitosamente.' };
}

// Document helpers
async function createDocument(db, docData, userId) {
  const document = {
    ...docData,
    userId: new ObjectId(userId),
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const result = await db.collection('documents').insertOne(document);
  return { message: 'Documento guardado.', insertedId: result.insertedId };
}

async function updateDocument(db, id, docData, userId) {
  const result = await db.collection('documents').updateOne(
    { _id: new ObjectId(id), userId: new ObjectId(userId) },
    { $set: { ...docData, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) throw new Error('Documento no encontrado o no tienes permisos.');
  return { message: 'Documento actualizado.' };
}

async function getDocument(db, id) {
  return db.collection('documents').findOne({ _id: new ObjectId(id) });
}

async function getDocuments(db, userId) {
  return db.collection('documents')
    .find({ userId: new ObjectId(userId) })
    .sort({ updatedAt: -1 })
    .toArray();
}

async function deleteDocument(db, id, userId) {
  const result = await db.collection('documents').deleteOne({
    _id: new ObjectId(id),
    userId: new ObjectId(userId)
  });
  if (result.deletedCount === 0) throw new Error('Documento no encontrado o no tienes permisos.');
  return { message: 'Documento eliminado.' };
}

// Template helpers
async function createTemplate(db, templateData, userId) {
  const template = {
    ...templateData,
    userId: new ObjectId(userId),
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const result = await db.collection('templates').insertOne(template);
  return { message: 'Plantilla guardada.', insertedId: result.insertedId };
}

async function updateTemplate(db, id, templateData, userId) {
  const result = await db.collection('templates').updateOne(
    { _id: new ObjectId(id), userId: new ObjectId(userId) },
    { $set: { ...templateData, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) throw new Error('Plantilla no encontrada o no tienes permisos.');
  return { message: 'Plantilla actualizada.' };
}

async function getTemplate(db, id) {
  return db.collection('templates').findOne({ _id: new ObjectId(id) });
}

async function getTemplates(db, userId) {
  return db.collection('templates')
    .find({ userId: new ObjectId(userId) })
    .sort({ updatedAt: -1 })
    .toArray();
}

async function deleteTemplate(db, id, userId) {
  const result = await db.collection('templates').deleteOne({
    _id: new ObjectId(id),
    userId: new ObjectId(userId)
  });
  if (result.deletedCount === 0) throw new Error('Plantilla no encontrada o no tienes permisos.');
  return { message: 'Plantilla eliminada.' };
}

async function getForm(db, id) {
  return db.collection('forms').findOne({ _id: new ObjectId(id) });
}

// Routes
app.get('/get-session', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.status(401).json({ error: 'No hay sesión activa.' });
  }
});

app.post('/register', async (req, res) => {
  try {
    const user = await registerUser(db, req.body);
    req.session.user = user;
    res.status(201).json({ message: 'Usuario registrado exitosamente.', user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    console.log('Login attempt:', req.body);
    const { email, password } = req.body;
    const user = await loginUser(db, email, password);
    req.session.user = user;
    console.log('Login successful:', user.email);
    res.status(200).json({ message: 'Inicio de sesión exitoso.', user });
  } catch (error) {
    console.error('Login error:', error.stack);
    res.status(401).json({ error: error.message });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      res.status(500).json({ error: 'No se pudo cerrar la sesión.' });
    } else {
      res.redirect('/index.html');
    }
  });
});

app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const message = await forgotPassword(db, email);
    res.status(200).json({ message });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const tokenDoc = await db.collection('resetTokens').findOne({ token, expires: { $gt: new Date() } });
    if (!tokenDoc) return res.status(400).send('El enlace de recuperación es inválido o ha expirado.');
    res.sendFile(path.join(__dirname, 'public', 'reset_password.html'));
  } catch (error) {
    res.status(500).send('Error al verificar el token.');
  }
});

app.post('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body;
  try {
    const message = await resetPassword(db, token, password, confirmPassword);
    res.status(200).json({ message });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/subscribe-newsletter', async (req, res) => {
  try {
    const result = await subscribeNewsletter(db, req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/unsubscribe-newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    const result = await unsubscribeNewsletter(db, email);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/create-event', requireAuth, async (req, res) => {
  try {
    const result = await createEvent(db, req.body, req.session.user._id);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/events', async (req, res) => {
  try {
    const events = await getEvents(db);
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
});

app.get('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await db.collection('calendar_events').findOne({ _id: new ObjectId(id), isPublic: true });
    if (event) {
      res.json({
        ...event,
        start: moment.tz(event.start, 'America/Mexico_City').toDate(),
        end: moment.tz(event.end, 'America/Mexico_City').toDate()
      });
    } else {
      res.status(404).json({ error: 'Evento no encontrado' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener el evento' });
  }
});

app.put('/events/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await updateEvent(db, id, req.body, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/update-profile', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user._id;
    const updatedUser = await updateProfile(db, userId, req.body);
    req.session.user = updatedUser; // Actualiza la sesión
    res.status(200).json({ message: 'Perfil actualizado exitosamente.', user: updatedUser });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/events/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteEvent(db, id, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/posts', requireAuth, upload.array('postMedia', 5), async (req, res) => {
  try {
    console.log('Received post request:', req.body, req.files);
    const isDraft = parseBool(req.body.isDraft);
    const result = await createPost(db, req.body, req.files, req.session.user._id, isDraft);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error in createPost:', error.stack);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category || null;
    const posts = await getPosts(db, page, limit, category);
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener publicaciones' });
  }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const post = await getPost(db, id);
    res.json(post);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.put('/api/posts/:id', requireAuth, upload.array('postMedia', 5), async (req, res) => {
  try {
    console.log('Received put request for post:', req.params.id, req.body, req.files);
    const { id } = req.params;
    const isDraft = parseBool(req.body.isDraft);
    const result = await updatePost(db, id, req.body, req.files, req.session.user._id, isDraft);
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in updatePost:', error.stack);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deletePost(db, id, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/forms', requireAuth, validateForm, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, formType, course, description, active, fields } = req.body;
    const activeBool = active === true || active === 'true';
    const userId = req.session.user._id;

    const sanitizedForm = {
      name: sanitizeHtml(name),
      formType: sanitizeHtml(formType),
      course: sanitizeHtml(course),
      description: sanitizeHtml(description),
      active: activeBool,
      status: activeBool ? 'published' : 'draft',
      fields: fields.map(field => ({
        id: field.id,
        type: field.type,
        label: sanitizeHtml(field.label),
        placeholder: field.placeholder ? sanitizeHtml(field.placeholder) : undefined,
        required: field.required,
        options: field.options ? field.options.map(opt => sanitizeHtml(opt)) : undefined,
        maxDigits: field.maxDigits,
        unique: field.unique,
        conditionalFields: field.conditionalFields ? Object.fromEntries(
          Object.entries(field.conditionalFields).map(([option, condFields]) => [
            sanitizeHtml(option),
            condFields.map(cf => ({
              id: cf.id,
              type: cf.type,
              label: sanitizeHtml(cf.label),
              placeholder: cf.placeholder ? sanitizeHtml(cf.placeholder) : undefined,
              required: cf.required,
              maxDigits: cf.maxDigits
            }))
          ])
        ) : undefined,
      })),
      userId: new ObjectId(userId),
      createdAt: new Date(),
      isPublic: activeBool,
    };

    const result = await db.collection('forms').insertOne(sanitizedForm);
    await redis.del('forms:cache');

    if (active) {
      const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['forms'] } }).toArray();
      for (const subscriber of subscribers) {
        emailQueue.add({
          from: 'no-reply@livetextweb.com',
          to: subscriber.email,
          subject: `Nuevo formulario: ${sanitizedForm.name}`,
          html: `Nuevo Formulario\nHola, ${subscriber.name},\nSe ha publicado un nuevo formulario: ${sanitizedForm.name}\n<a href="http://localhost:3000/pagos.html#form-${result.insertedId}">Ver detalles</a>\nSaludos,\nEquipo LIVETEXT`
        });
      }
    }

    res.status(201).json({ message: 'Formulario creado exitosamente.', insertedId: result.insertedId });
  } catch (error) {
    console.error('Error al crear formulario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/forms', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const formType = req.query.formType || null;
    const cacheKey = `forms:cache:${page}:${limit}:${formType || 'all'}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const query = req.session.user ? { userId: new ObjectId(req.session.user._id) } : { isPublic: true };
    if (formType) query.formType = formType;

    const forms = await db.collection('forms')
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    const formattedForms = forms.map(form => ({
      _id: form._id,
      name: form.name,
      formType: form.formType,
      course: form.course,
      description: form.description,
      createdAt: moment.tz(form.createdAt, 'America/Mexico_City').toDate(),
      fields: form.fields,
      active: form.active,
      status: form.status,
    }));

    await redis.setex(cacheKey, 300, JSON.stringify(formattedForms));
    res.json(formattedForms);
  } catch (error) {
    console.error('Error al obtener formularios:', error);
    res.status(500).json({ error: 'Error al obtener formularios' });
  }
});

app.get('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    const form = await getForm(db, req.params.id);
    if (!form) return res.status(404).json({ error: 'Formulario no encontrado' });
    res.json(form);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener formulario' });
  }
});

app.put('/api/forms/:id', requireAuth, validateForm, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { name, formType, course, description, active, fields } = req.body;
    const activeBool = active === true || active === 'true';
    const userId = req.session.user._id;

    const sanitizedForm = {
      name: sanitizeHtml(name),
      formType: sanitizeHtml(formType),
      course: sanitizeHtml(course),
      description: sanitizeHtml(description),
      active: activeBool,
      status: activeBool ? 'published' : 'draft',
      fields: fields.map(field => ({
        id: field.id,
        type: field.type,
        label: sanitizeHtml(field.label),
        placeholder: field.placeholder ? sanitizeHtml(field.placeholder) : undefined,
        required: field.required,
        options: field.options ? field.options.map(opt => sanitizeHtml(opt)) : undefined,
        maxDigits: field.maxDigits,
        unique: field.unique,
        conditionalFields: field.conditionalFields ? Object.fromEntries(
          Object.entries(field.conditionalFields).map(([option, condFields]) => [
            sanitizeHtml(option),
            condFields.map(cf => ({
              id: cf.id,
              type: cf.type,
              label: sanitizeHtml(cf.label),
              placeholder: cf.placeholder ? sanitizeHtml(cf.placeholder) : undefined,
              required: cf.required,
              maxDigits: cf.maxDigits
            }))
          ])
        ) : undefined,
      })),
      updatedAt: new Date(),
      isPublic: activeBool,
    };

    const result = await db.collection('forms').updateOne(
      { _id: new ObjectId(id), userId: new ObjectId(userId) },
      { $set: sanitizedForm }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Formulario no encontrado o no tienes permisos.' });
    }

    await redis.del('forms:cache');

    if (active) {
      const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['forms'] } }).toArray();
      for (const subscriber of subscribers) {
        emailQueue.add({
          from: 'no-reply@livetextweb.com',
          to: subscriber.email,
          subject: `Formulario actualizado: ${sanitizedForm.name}`,
          html: `Formulario Actualizado\nHola, ${subscriber.name},\nSe ha actualizado el formulario: ${sanitizedForm.name}\n<a href="http://localhost:3000/pagos.html#form-${id}">Ver detalles</a>\nSaludos,\nEquipo LIVETEXT`
        });
      }
    }

    res.status(200).json({ message: 'Formulario actualizado exitosamente.' });
  } catch (error) {
    console.error('Error al actualizar formulario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteForm(db, id, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/form-submissions', upload.fields([
  { name: 'files', maxCount: 10 }, // Adjust based on max files allowed
]), (req, res, next) => {
  if (typeof req.body.responses === 'string') {
    try {
      req.body.responses = JSON.parse(req.body.responses);
    } catch (err) {
      return res.status(400).json({ error: 'Formato de respuestas inválido' });
    }
  }
  next();
}, validateFormSubmission, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { formId, responses } = req.body;
    const files = req.files['files'] || [];

    // Verify form exists
    const form = await db.collection('forms').findOne({ _id: new ObjectId(formId), isPublic: true });
    if (!form) {
      return res.status(404).json({ error: 'Formulario no encontrado' });
    }

    // Check for email uniqueness
    for (const response of responses) {
      if (response.type === 'email') {
        const existingSubmission = await db.collection('form_submissions').findOne({
          formId: new ObjectId(formId),
          'responses.fieldId': response.fieldId,
          'responses.value': response.value,
        });
        if (existingSubmission) {
          return res.status(400).json({ error: `El correo ${response.value} ya ha sido usado en este formulario` });
        }
      }
    }

    // Sanitize responses
    const sanitizedResponses = responses.map(response => ({
      fieldId: response.fieldId,
      type: response.type,
      value: ['text', 'email', 'tel', 'textarea'].includes(response.type) ? sanitizeHtml(response.value) : response.value,
    }));

    // Process files
    const processedFiles = files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      path: `/uploads/${file.filename}`,
      contentType: file.mimetype,
      fieldId: file.fieldname, // Associate with fieldId if needed
    }));

    // Create submission
    const submission = {
      formId: new ObjectId(formId),
      responses: sanitizedResponses,
      files: processedFiles,
      createdAt: new Date(),
      status: 'pending', // For review process
    };

    const result = await db.collection('form_submissions').insertOne(submission);

    // Notify admins (example)
    const admins = await db.collection('users').find({ role: 'admin' }).toArray();
    for (const admin of admins) {
      emailQueue.add({
        from: 'no-reply@livetextweb.com',
        to: admin.email,
        subject: `Nueva presentación de formulario: ${form.name}`,
        html: `Nueva Presentación de Formulario
Hola, ${admin.name},
Se ha recibido una nueva presentación para el formulario: ${form.name}
<a href="http://localhost:3000/dashboard_pagos#submission-${result.insertedId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
      });
    }

    res.status(201).json({ message: 'Formulario enviado exitosamente.', insertedId: result.insertedId });
  } catch (error) {
    console.error('Error al enviar formulario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/form-submissions', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const submissions = await db.collection('form_submissions')
      .find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener envíos' });
  }
});

app.get('/api/form-submissions/:id', requireAuth, async (req, res) => {
  try {
    const submission = await db.collection('form_submissions').findOne({ _id: new ObjectId(req.params.id) });
    if (!submission) return res.status(404).json({ error: 'Envío no encontrado' });
    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener envío' });
  }
});

app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    let visitorId = req.cookies.visitorId;
    if (!visitorId) {
      visitorId = crypto.randomBytes(16).toString('hex');
      res.cookie('visitorId', visitorId, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
    }
    const post = await db.collection('posts').findOne({ _id: new ObjectId(id), isPublic: true });
    if (!post || !post.allowComments) throw new Error('Los comentarios no están permitidos para esta publicación.');
    const result = await createComment(db, id, req.body, visitorId);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const comments = await getComments(db, id);
    res.json(comments);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener comentarios' });
  }
});

app.post('/api/resources', requireAuth, resourceUpload.any(), async (req, res) => {
  try {
    const files = (req.files || []).filter(f => f.fieldname.startsWith('files'));
    const result = await createResource(db, req.body, files, req.session.user._id);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error al subir recurso:', error);
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: `Error de archivo: ${error.message}` });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

// Endpoint legacy para compatibilidad con versiones anteriores del frontend
app.post('/upload-resource', requireAuth, resourceUpload.any(), async (req, res) => {
  try {
    const files = (req.files || []).filter(f => f.fieldname.startsWith('files'));
    const result = await createResource(db, req.body, files, req.session.user._id);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error al subir recurso:', error);
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: `Error de archivo: ${error.message}` });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

app.get('/api/resources', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const resources = await getResources(db, page, limit);
    res.json(resources);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener recursos' });
  }
});

app.get('/api/resources/:id', async (req, res) => {
  try {
    const resource = await getResource(db, req.params.id);
    if (!resource) return res.status(404).json({ error: 'Recurso no encontrado' });
    res.json(resource);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener recurso' });
  }
});

app.put('/api/resources/:id', requireAuth, resourceUpload.any(), async (req, res) => {
  try {
    const files = (req.files || []).filter(f => f.fieldname.startsWith('files'));
    const result = await updateResource(db, req.params.id, req.body, files, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/resources/:id', requireAuth, async (req, res) => {
  try {
    const result = await deleteResource(db, req.params.id, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Public endpoint for listing educational resources
app.get('/educational-resources', async (req, res) => {
  try {
    const filter = req.query.filter && req.query.filter !== 'all' ? req.query.filter : null;
    const search = req.query.search ? req.query.search.trim() : null;
    const query = { isPublic: true };
    if (filter) query.category = filter;
    if (search) query.title = { $regex: new RegExp(search, 'i') };
    const resources = await db
      .collection('resources')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
    const formatted = resources.map(r => ({
      title: r.title,
      category: r.category,
      uploadDate: r.createdAt,
      filePaths: (r.files || []).map(f => f.path),
      fileTypes: (r.files || []).map(f => path.extname(f.originalname).slice(1).toLowerCase())
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener recursos' });
  }
});

app.post('/api/documents', requireAuth, async (req, res) => {
  try {
    const result = await createDocument(db, req.body, req.session.user._id);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const docs = await getDocuments(db, req.session.user._id);
    res.json(docs);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener documentos' });
  }
});

app.get('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const doc = await getDocument(db, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener documento' });
  }
});

app.put('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const result = await updateDocument(db, req.params.id, req.body, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const result = await deleteDocument(db, req.params.id, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Template routes
app.post('/api/templates', requireAuth, async (req, res) => {
  try {
    const result = await createTemplate(db, req.body, req.session.user._id);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/templates', requireAuth, async (req, res) => {
  try {
    const templates = await getTemplates(db, req.session.user._id);
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener plantillas' });
  }
});

app.get('/api/templates/:id', requireAuth, async (req, res) => {
  try {
    const template = await getTemplate(db, req.params.id);
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener plantilla' });
  }
});

app.put('/api/templates/:id', requireAuth, async (req, res) => {
  try {
    const result = await updateTemplate(db, req.params.id, req.body, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/templates/:id', requireAuth, async (req, res) => {
  try {
    const result = await deleteTemplate(db, req.params.id, req.session.user._id);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const start = new Date();
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);

    const [pendingPayments, postCount, subscriberCount, paymentsDailyAgg, postsDailyAgg, subscribersDailyAgg] = await Promise.all([
      db.collection('form_submissions').countDocuments({ status: 'pending' }),
      db.collection('posts').countDocuments(),
      db.collection('newsletter_subscribers').countDocuments({ subscribed: true }),
      db.collection('form_submissions').aggregate([
        { $match: { status: 'pending', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection('posts').aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection('newsletter_subscribers').aggregate([
        { $match: { createdAt: { $gte: start }, subscribed: true } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray()
    ]);

    const formatDaily = (arr) => arr.reduce((acc, cur) => {
      acc[cur._id] = cur.count;
      return acc;
    }, {});

    res.json({
      pendingPayments,
      postCount,
      subscriberCount,
      paymentsDaily: formatDaily(paymentsDailyAgg),
      postsDaily: formatDaily(postsDailyAgg),
      subscribersDaily: formatDaily(subscribersDailyAgg)
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Validación de línea de captura con servicio gubernamental
app.post('/api/validate-capture', requireAuth, async (req, res) => {
  const { capture } = req.body;
  if (!capture) return res.status(400).json({ error: 'Falta línea de captura' });

  try {
    const params = new URLSearchParams({ lineaCaptura: capture });
    const response = await fetch('https://sfpya.edomexico.gob.mx/controlv/consultas/ConsultaDatos.jsp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const html = await response.text();
    const valid = !/no\s+se\s+encontr/i.test(html);
    res.json({ valid });
  } catch (error) {
    console.error('Error al validar captura:', error);
    res.status(500).json({ error: 'Error al validar captura' });
  }
});

// Servicio de chat IA utilizando OpenAI
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Formato de mensajes inválido' });
  }
  try {
    const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content?.toLowerCase() || '';
    const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f?¿!,.]/g, '').toLowerCase();
    const words = new Set(normalize(lastUserMsg).split(/\s+/));
    let bestMatch = null;
    let bestScore = 0;
    for (const qa of trainingData) {
      const qWords = new Set(normalize(qa.question).split(/\s+/));
      const intersection = [...words].filter(w => qWords.has(w));
      const score = intersection.length / Math.min(qWords.size, words.size);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = qa;
      }
    }
    if (bestMatch && bestScore >= 0.5) {
      return res.json({ reply: bestMatch.answer });
    }
    return res.json({ reply: 'Lo siento, no tengo información sobre eso. Puedes consultar directamente al CLE.' });
  } catch (error) {
    console.error('Error en chat IA:', error);
    const errMsg = error?.error?.message || error?.message;
    res.status(500).json({ error: errMsg || 'Error en servicio de chat' });
  }
});

// Entrenamiento de la IA con pares pregunta/respuesta
app.post('/api/train', requireAuth, async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  trainingData.push({ question, answer });
  try {
    fs.writeFileSync(TRAINING_DATA_FILE, JSON.stringify(trainingData, null, 2));
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Error al guardar entrenamiento:', error);
    res.status(500).json({ error: 'No se pudo guardar' });
  }
});

app.post('/upload-resource', requireAuth, resourceUpload.any(), async (req, res) => {
  try {
    const files = (req.files || []).filter(f => f.fieldname.startsWith('files'));
    const result = await createResource(db, req.body, files, req.session.user._id);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error al subir recurso:', error);
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: `Error de archivo: ${error.message}` });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

// Queue Processing
emailQueue.process(async (job) => {
  try {
    await transporter.sendMail(job.data);
  } catch (error) {
    console.error('Error al enviar correo:', error);
  }
});

postQueue.process(async (job) => {
  const { postId } = job.data;
  try {
    const post = await db.collection('posts').findOne({ _id: new ObjectId(postId) });
    if (!post) return;
    await db.collection('posts').updateOne(
      { _id: new ObjectId(postId) },
      { $set: { isPublic: true } }
    );
    await redis.del('posts:cache');
    await redis.del(`post:${postId}`);
    const subscribers = await db.collection('newsletter_subscribers').find({ subscribed: true, notificationTypes: { $in: ['posts'] } }).toArray();
    for (const subscriber of subscribers) {
      emailQueue.add({
        from: 'no-reply@livetextweb.com',
        to: subscriber.email,
        subject: `Nueva publicación: ${post.title}`,
        html: `Nueva Publicación
Hola, ${subscriber.name},
Se ha publicado una nueva publicación: ${post.title}
Fecha: ${moment.tz(post.date, 'America/Mexico_City').format('LLL')}
<a href="http://localhost:3000/index.html#post-${postId}">Ver detalles</a>
Saludos,
Equipo LIVETEXT
`
      });
    }
  } catch (error) {
    console.error('Error al procesar publicación programada:', error);
  }
});

connect().then(() => {
  app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
  });
}).catch(error => console.error('Error al iniciar el servidor:', error));