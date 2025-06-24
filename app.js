const express = require('express');
const session = require('express-session');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const path = require('path');
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

const app = express();
const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client = new MongoClient(uri);
const redis = new Redis({ host: 'localhost', port: 6379 });
const emailQueue = new Queue('email-notifications', { redis: { host: 'localhost', port: 6379 } });
const postQueue = new Queue('post-publishing', { redis: { host: 'localhost', port: 6379 } });

app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(session({
    secret: 'clave-secreta-fuerte',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
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
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|mp4|webm/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        cb(new Error('Solo se permiten imágenes y videos (JPEG, PNG, GIF, MP4, WebM)'));
    }
});

let db;

require('dotenv').config();
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
    'crea_calendario.html', 'editar_events.html', 'dashboard.html', 'crear_form.html',
    'editor.html', 'crear_post.html', 'editar_posts.html', 'dashboard_documentos.html',
    'dashboard_pagos.html', 'perfil.html', 'subir_recurso.html'
];

app.use((req, res, next) => {
    const requestedPath = req.path === '/' ? 'index.html' : path.basename(req.path);
    if (restrictedPages.includes(requestedPath)) requireAuth(req, res, next);
    else next();
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
        'calendar_events', 'posts', 'resources', 'newsletter_subscribers', 'forms', 'comments'
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
        return { message: 'Preferencias de notificación actualizadas.' };
    } else {
        const subscriber = { name, email, subscribed: true, notificationTypes, createdAt: new Date() };
        await db.collection('newsletter_subscribers').insertOne(subscriber);
        return { message: 'Suscripción a notificaciones exitosa.' };
    }
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
    const { title, description, category } = resourceData;
    if (!title || !description) throw new Error('Título y descripción son obligatorios.');
    const resource = {
        title: title.trim(),
        description: sanitizeHtml(description),
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
    let postDateTime = now;
    if (schedulePost === 'true' && date && time) {
        postDateTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', 'America/Mexico_City').toDate();
        if (!moment(postDateTime).isValid()) throw new Error('Formato de fecha u hora inválido.');
        if (!isDraft && postDateTime < now) throw new Error('No puedes programar una publicación en el pasado.');
    } else if (schedulePost === 'true') {
        throw new Error('Fecha y hora son obligatorios cuando se programa la publicación.');
    }
    const post = {
        title: title.trim(),
        content: sanitizedContent,
        category,
        allowComments: allowComments === 'true',
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
            throw new Error(`Error de archivo: ${error.message} (Límite: 20MB)`);
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
    let postDateTime = now;
    if (schedulePost === 'true' && date && time) {
        postDateTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', 'America/Mexico_City').toDate();
        if (!moment(postDateTime).isValid()) throw new Error('Formato de fecha u hora inválido.');
        if (!isDraft && postDateTime < now) throw new Error('No puedes programar una publicación en el pasado.');
    } else if (schedulePost === 'true') {
        throw new Error('Fecha y hora son obligatorios cuando se programa la publicación.');
    }
    const updateData = {
        title: title.trim(),
        content: sanitizedContent,
        category,
        allowComments: allowComments === 'true',
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
            throw new Error(`Error de archivo: ${error.message} (Límite: 20MB)`);
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
    const { title, description, createdAt = new Date() } = formData;
    const form = { title, description, createdAt, isPublic: true, userId: new ObjectId(userId) };
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
        const isDraft = req.body.isDraft === 'true';
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
        const isDraft = req.body.isDraft === 'true';
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

app.post('/api/forms', requireAuth, async (req, res) => {
    try {
        const result = await createForm(db, req.body, req.session.user._id);
        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/forms', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const forms = await getForms(db, page, limit);
        res.json(forms);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener formularios' });
    }
});

app.put('/api/forms/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await updateForm(db, id, req.body, req.session.user._id);
        res.status(200).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
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

app.post('/api/resources', requireAuth, upload.array('resourceFiles', 5), async (req, res) => {
    try {
        const result = await createResource(db, req.body, req.files, req.session.user._id);
        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
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