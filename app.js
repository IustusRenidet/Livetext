const express = require('express');
const session = require('express-session');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const moment = require('moment');
const { DateTime } = require('luxon');

const app = express();
const uri = 'mongodb://localhost:27017'; // URI de conexión a MongoDB
const client = new MongoClient(uri);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'clave-secreta-fuerte', // Cambia por una clave más segura
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Cambia a true si usas HTTPS
}));

let db;

// Configuración de Nodemailer con Brevo usando .env
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

// Middleware para verificar autenticación
function requireAuth(req, res, next) {
    if (req.session.user) {
        next(); // Usuario autenticado, continuar
    } else {
        res.redirect('/login.html'); // No autenticado, redirigir a login
    }
}

// Lista de rutas restringidas
const restrictedPages = [
    'dashboard.html',
    'crear_form.html',
    'editor.html',
    'crear_calendario.html',
    'crear_post.html',
    'dashboard_documentos.html',
    'dashboard_pagos.html',
    'perfil.html',
    'subir_recurso.html'
];

// Middleware para manejar archivos estáticos con autenticación
app.use((req, res, next) => {
    const requestedPath = req.path === '/' ? 'index.html' : path.basename(req.path);
    if (restrictedPages.includes(requestedPath)) {
        requireAuth(req, res, next);
    } else {
        next();
    }
});

// Sirve archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Conecta a MongoDB
async function connect() {
    try {
        await client.connect();
        console.log('Conectado a MongoDB');
        db = client.db('livetext');
        await ensureCollections(db);
        return db;
    } catch (error) {
        console.error('Error al conectar a MongoDB:', error);
        process.exit(1);
    }
}

// Asegura que las colecciones existan
async function ensureCollections(db) {
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);

    if (!collectionNames.includes('users')) await db.createCollection('users');
    if (!collectionNames.includes('codigos')) {
        await db.createCollection('codigos');
        await db.collection('codigos').insertMany([{ code: 'PROF1', available: true }, { code: 'PROF2', available: true }, { code: 'PROF3', available: true }]);
    }
    if (!collectionNames.includes('resetTokens')) await db.createCollection('resetTokens');
    if (!collectionNames.includes('notificationsQueue')) await db.createCollection('notificationsQueue');
    if (!collectionNames.includes('events')) await db.createCollection('events');
    if (!collectionNames.includes('calendar_events')) await db.createCollection('calendar_events');
}

// Lógica de registro de usuarios
async function registerUser(db, userData) {
    const { name, surname, secondSurname, email, password, confirmPassword, code } = userData;

    // Validar nombre y apellidos (letras y espacios)
    if (!/^[a-zA-Z\s]+$/.test(name) || !/^[a-zA-Z\s]+$/.test(surname) || !/^[a-zA-Z\s]+$/.test(secondSurname)) {
        throw new Error('El nombre y apellidos solo deben contener letras y espacios.');
    }

    // Validar correo (solo unicidad y formato)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        throw new Error('El correo electrónico no tiene un formato válido.');
    }
    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
        throw new Error('El correo ya está en uso.');
    }

    // Validar contraseña (mínimo 8 caracteres, letras y números)
    if (!/^(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d]{8,}$/.test(password)) {
        throw new Error('La contraseña debe tener al menos 8 caracteres, incluyendo letras y números.');
    }

    // Validar coincidencia de contraseñas
    if (password !== confirmPassword) {
        throw new Error('Las contraseñas no coinciden.');
    }

    // Validar código
    const codeDoc = await db.collection('codigos').findOne({ code, available: true });
    if (!codeDoc) {
        throw new Error('Código inválido o ya utilizado.');
    }

    // Encriptar contraseña
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Crear objeto de usuario
    const user = {
        name,
        surname,
        secondSurname,
        email,
        password: hashedPassword,
        createdAt: new Date(),
        subscribed: false,
        notificationFrequency: 'weekly',
        notificationTypes: []
    };

    // Insertar usuario y actualizar disponibilidad del código
    await db.collection('users').insertOne(user);
    await db.collection('codigos').updateOne({ code }, { $set: { available: false } });

    return user;
}

// Lógica de suscripción al boletín
async function subscribeNewsletter(db, userData) {
    const { name, email, notificationFrequency = 'weekly', notificationTypes = [] } = userData;

    // Validar nombre
    if (!/^[a-zA-Z\s]+$/.test(name)) {
        throw new Error('El nombre solo debe contener letras y espacios.');
    }

    // Validar correo
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        throw new Error('El correo electrónico no tiene un formato válido.');
    }

    // Validar notificationTypes
    const validTypes = ['posts', 'resources', 'events', 'payments'];
    if (!notificationTypes.every(type => validTypes.includes(type))) {
        throw new Error('Los tipos de notificación deben ser posts, resources, events o payments.');
    }

    // Verificar si el usuario ya existe
    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
        // Actualizar preferencias si ya existe
        await db.collection('users').updateOne(
            { email },
            { $set: { subscribed: true, notificationFrequency: 'weekly', notificationTypes } }
        );
        return { message: 'Preferencias de notificación actualizadas.' };
    } else {
        // Crear nuevo usuario para boletín (sin contraseña)
        const user = {
            name,
            email,
            subscribed: true,
            notificationFrequency: 'weekly',
            notificationTypes,
            createdAt: new Date()
        };
        await db.collection('users').insertOne(user);
        return { message: 'Suscripción al boletín exitosa.' };
    }
}

// Lógica para darse de baja
async function unsubscribeNewsletter(db, email) {
    const user = await db.collection('users').findOne({ email });
    if (!user) {
        throw new Error('No se encontró un usuario con ese correo.');
    }

    await db.collection('users').updateOne(
        { email },
        { $set: { subscribed: false, notificationFrequency: 'weekly', notificationTypes: [] } }
    );
    return { message: 'Te has dado de baja exitosamente.' };
}

// Lógica de inicio de sesión
async function loginUser(db, email, password) {
    const user = await db.collection('users').findOne({ email });
    if (!user) {
        throw new Error('Usuario no encontrado.');
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        throw new Error('Contraseña incorrecta.');
    }

    return user;
}

// Lógica para "Olvidé mi contraseña"
async function forgotPassword(db, email) {
    const user = await db.collection('users').findOne({ email });
    if (!user) {
        throw new Error('No se encontró un usuario con ese correo.');
    }

    // Generar token de recuperación
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000); // Expira en 1 hora

    // Guardar token en la colección resetTokens
    await db.collection('resetTokens').insertOne({
        email,
        token,
        expires
    });

    // Enviar correo con el enlace de recuperación
    const resetLink = `http://localhost:3000/reset-password/${token}`;
    const mailOptions = {
        from: 'no-reply@livetextweb.com',
        to: email,
        subject: 'Restablecer tu contraseña - LIVETEXT',
        html: `
            <h2>Restablecer contraseña</h2>
            <p>Hola, ${user.name},</p>
            <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el siguiente enlace para crear una nueva contraseña:</p>
            <a href="${resetLink}" style="background-color: #e67e22; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Restablecer contraseña</a>
            <p>Este enlace expirará en 1 hora.</p>
            <p>Si no solicitaste este cambio, ignora este correo.</p>
            <p>Saludos,<br>Equipo LIVETEXT</p>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Respuesta de Brevo:', info.response);
        console.log('Mensaje enviado a:', email);
        return 'Correo de recuperación enviado exitosamente.';
    } catch (error) {
        console.error('Error al enviar correo:', error.message, error.stack);
        throw new Error('Error al enviar el correo de recuperación. Verifica las credenciales en .env.');
    }
}

// Lógica para restablecer contraseña
async function resetPassword(db, token, newPassword, confirmPassword) {
    if (!/^(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d]{8,}$/.test(newPassword)) {
        throw new Error('La contraseña debe tener al menos 8 caracteres, incluyendo letras y números.');
    }

    if (newPassword !== confirmPassword) {
        throw new Error('Las contraseñas no coinciden.');
    }

    const tokenDoc = await db.collection('resetTokens').findOne({
        token,
        expires: { $gt: new Date() }
    });

    if (!tokenDoc) {
        throw new Error('El enlace de recuperación es inválido o ha expirado.');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await db.collection('users').updateOne(
        { email: tokenDoc.email },
        { $set: { password: hashedPassword } }
    );

    await db.collection('resetTokens').deleteOne({ token });

    return 'Contraseña restablecida exitosamente.';
}

// Lógica para actualizar perfil
async function updateProfile(db, email, userData) {
    const { name, surname, secondSurname, password, confirmPassword } = userData;

    // Validar nombre y apellidos
    if (!/^[a-zA-Z\s]+$/.test(name) || !/^[a-zA-Z\s]+$/.test(surname) || !/^[a-zA-Z\s]+$/.test(secondSurname)) {
        throw new Error('El nombre y apellidos solo deben contener letras y espacios.');
    }

    // Validar correo
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        throw new Error('El correo electrónico no tiene un formato válido.');
    }

    // Validar contraseña si se proporciona
    let updateData = { name, surname, secondSurname, email };
    if (password && confirmPassword) {
        if (!/^(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d]{8,}$/.test(password)) {
            throw new Error('La contraseña debe tener al menos 8 caracteres, incluyendo letras y números.');
        }
        if (password !== confirmPassword) {
            throw new Error('Las contraseñas no coinciden.');
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        updateData.password = hashedPassword;
    }

    await db.collection('users').updateOne({ email }, { $set: updateData });
    return { message: 'Perfil actualizado exitosamente.' };
}

// Lógica para crear evento
async function createEvent(db, eventData) {
    const { type, title, course, date, startTime, endTime, location, instructor, description, isRecurring, recurrencePattern, recurrenceEnd, sendNotification } = eventData;
    const startDateTime = moment(`${date} ${startTime}`).toDate();
    const endDateTime = moment(`${date} ${endTime}`).toDate();
    const eventsToInsert = [];

    if (isRecurring && recurrenceEnd) {
        const endRecurDate = moment(recurrenceEnd).toDate();
        let currentDate = moment(startDateTime);

        while (currentDate.isSameOrBefore(endRecurDate)) {
            eventsToInsert.push({
                type,
                title,
                course,
                start: currentDate.toDate(),
                end: moment(currentDate).add(moment(endDateTime).diff(moment(startDateTime), 'minutes'), 'minutes').toDate(),
                location,
                instructor,
                description,
                color: eventColors[type] || '#e67e22',
                createdAt: new Date(),
                isPublic: true
            });
            currentDate.add(recurrencePattern === 'daily' ? 1 : recurrencePattern === 'weekly' ? 7 : 30, 'days');
        }
    } else {
        eventsToInsert.push({
            type,
            title,
            course,
            start: startDateTime,
            end: endDateTime,
            location,
            instructor,
            description,
            color: eventColors[type] || '#e67e22',
            createdAt: new Date(),
            isPublic: true
        });
    }

    await db.collection('calendar_events').insertMany(eventsToInsert);

    if (sendNotification) {
        for (const event of eventsToInsert) {
            await addNotification(db, type, title, description, `/calendario.html#${event._id}`);
        }
    }

    return { message: 'Evento(s) creado(s) exitosamente.' };
}

// Función para obtener eventos
async function getEvents(db) {
    return await db.collection('calendar_events').find({ isPublic: true }).toArray();
}

// Colores de eventos
const eventColors = {
    'convocatoria': '#3498db',
    'clase': '#e67e22',
    'evento': '#9b59b6',
    'examen': '#e74c3c',
    'parcial': '#f39c12',
    'intersemestral': '#1abc9c',
    'curso-especial': '#34495e',
    'intensivo': '#e67e22',
    'sabatino': '#8e44ad',
    'verano': '#f1c40f'
};

// Función para agregar un ítem a la cola de notificaciones
async function addNotification(db, type, title, description, link) {
    await db.collection('notificationsQueue').insertOne({
        type,
        title,
        description,
        link,
        createdAt: new Date(),
        sent: false,
        userEmails: []
    });
}

// Función para enviar resumen semanal
async function sendWeeklyDigest(db) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const unsentNotifications = await db.collection('notificationsQueue')
        .find({ createdAt: { $gte: weekAgo }, sent: false })
        .toArray();

    if (unsentNotifications.length > 0) {
        const users = await db.collection('users').find({
            subscribed: true
        }).toArray();

        for (const user of users) {
            const relevantNotifications = unsentNotifications.filter(n =>
                user.notificationTypes.includes(n.type)
            );
            if (relevantNotifications.length > 0) {
                const mailOptions = {
                    from: 'no-reply@livetextweb.com',
                    to: user.email,
                    subject: 'Resumen semanal de LIVETEXT',
                    html: `
                        <h2>Resumen semanal - LIVETEXT</h2>
                        <p>Hola, ${user.name},</p>
                        <p>Aquí tienes un resumen de las actualizaciones de la semana:</p>
                        ${relevantNotifications.map(n => `
                            <div>
                                <h3>${n.type}: ${n.title}</h3>
                                <p>${n.description}</p>
                                <p><a href="${n.link}" style="background-color: #e67e22; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Ver detalles</a></p>
                            </div>
                        `).join('')}
                        <p>Saludos,<br>Equipo LIVETEXT</p>
                    `
                };

                try {
                    await transporter.sendMail(mailOptions);
                    await db.collection('notificationsQueue').updateMany(
                        { _id: { $in: relevantNotifications.map(n => n._id) } },
                        { $set: { sent: true, userEmails: [user.email] } }
                    );
                    console.log(`Resumen semanal enviado a: ${user.email}`);
                } catch (error) {
                    console.error('Error al enviar resumen semanal:', error);
                }
            }
        }
    }
}

// Rutas de la API

// Ruta para obtener datos de la sesión
app.get('/get-session', (req, res) => {
    if (req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.status(401).json({ error: 'No hay sesión activa.' });
    }
});

// Ruta de registro
app.post('/register', async (req, res) => {
    try {
        const user = await registerUser(db, req.body);
        req.session.user = user;
        res.status(201).json({ message: 'Usuario registrado exitosamente.', user });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Ruta de inicio de sesión
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await loginUser(db, email, password);
        req.session.user = user;
        res.status(200).json({ message: 'Inicio de sesión exitoso.', user });
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// Ruta para cerrar sesión
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            res.status(500).json({ error: 'No se pudo cerrar la sesión.' });
        } else {
            res.redirect('/index.html');
        }
    });
});

// Ruta para "Olvidé mi contraseña"
app.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const message = await forgotPassword(db, email);
        res.status(200).json({ message });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Ruta para restablecer contraseña
app.get('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    try {
        console.log('Verificando token:', token);
        const tokenDoc = await db.collection('resetTokens').findOne({
            token,
            expires: { $gt: new Date() }
        });
        if (!tokenDoc) {
            console.log('Token no encontrado o expirado');
            return res.status(400).send('El enlace de recuperación es inválido o ha expirado.');
        }
        console.log('Token válido, sirviendo reset_password.html');
        res.sendFile(path.join(__dirname, 'public', 'reset_password.html'));
    } catch (error) {
        console.error('Error al verificar token:', error);
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

// Ruta para suscribirse al boletín
app.post('/subscribe-newsletter', async (req, res) => {
    try {
        const result = await subscribeNewsletter(db, req.body);
        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Ruta para darse de baja del boletín
app.post('/unsubscribe-newsletter', async (req, res) => {
    try {
        const { email } = req.body;
        const result = await unsubscribeNewsletter(db, email);
        res.status(200).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Ruta para actualizar perfil
app.post('/update-profile', async (req, res) => {
    try {
        const email = req.session.user.email;
        const result = await updateProfile(db, email, req.body);
        req.session.user = await db.collection('users').findOne({ email }); // Actualizar sesión
        res.status(200).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Ruta para crear evento
app.post('/create-event', requireAuth, async (req, res) => {
    try {
        const eventData = req.body;
        const result = await createEvent(db, eventData);
        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Ruta para obtener eventos
app.get('/events', async (req, res) => {
    try {
        const events = await getEvents(db);
        res.json(events);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener eventos.' });
    }
});

// Ruta para agregar notificaciones (ejemplo)
app.post('/add-notification', async (req, res) => {
    try {
        const { type, title, description, link } = req.body;
        await addNotification(db, type, title, description, link);
        res.status(201).json({ message: 'Notificación agregada a la cola.' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Iniciar job semanal
setInterval(async () => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 0 && now.getMinutes() === 0) {
        await sendWeeklyDigest(db);
    }
}, 60000); // Verifica cada minuto (ajusta a 24h en producción: 86400000)

// Iniciar servidor
connect().then(() => {
    app.listen(3000, () => {
        console.log('Servidor corriendo en http://localhost:3000');
    });
});