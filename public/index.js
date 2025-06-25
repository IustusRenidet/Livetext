// /js/index.js
document.addEventListener('DOMContentLoaded', () => {
    const publicacionesContainer = document.getElementById('publicaciones-container');
    const posts = [
        {
            id: 1,
            title: "¡Últimos Lugares para Inglés Intermedio!",
            category: "ingles",
            content: "¡No te pierdas nuestro curso de inglés intermedio! Perfecciona tu gramática y conversación. <strong>Inicia el 1 de junio.</strong> ¡Inscríbete ya!",
            media: [{ type: "image", url: "https://images.unsplash.com/photo-1524178232363-1fb2b075b655" }],
            mediaMode: "manual",
            allowComments: true,
            likes: 30,
            comments: 5
        },
        {
            id: 2,
            title: "Taller de Pronunciación Francesa 🇫🇷",
            category: "eventos frances",
            content: "Mejora tu acento francés en nuestro taller intensivo. <em>Incluye ejercicios prácticos y feedback personalizado.</em> 📅 Fecha: 15 de junio, 4 PM. Lugar: Auditorio CLEM. ¡Entrada libre, regístrate en nuestro sitio!",
            media: [
                { type: "video", url: "https://videos.pexels.com/video-files/8558933/8558933-sd_360_640_24fps.mp4" },
                { type: "video", url: "https://videos.pexels.com/video-files/3209307/3209307-sd_360_640_24fps.mp4" }
            ],
            mediaMode: "auto",
            allowComments: true,
            likes: 50,
            comments: 12
        },
        {
            id: 3,
            title: "Domina el Vocabulario de Negocios en Inglés",
            category: "recursos ingles",
            content: "Nuestra nueva guía gratuita te ayudará a dominar el inglés de negocios. Incluye: <ul><li>500 palabras y frases clave.</li><li>Ejemplos en contextos reales.</li><li>Ejercicios interactivos.</li></ul> 📥 <a href='https://example.com/business_english.pdf'>Descárgala ahora</a>. Perfecta para profesionales y estudiantes avanzados.",
            media: [
                { type: "image", url: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c" },
                { type: "image", url: "https://images.unsplash.com/photo-1552581234-26160f608093" },
                { type: "image", url: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40" }
            ],
            mediaMode: "gallery",
            allowComments: false,
            likes: 20,
            comments: 0
        },
        {
            id: 4,
            title: "Nuevos Horarios de Cursos",
            category: "anuncios",
            content: "Consulta los horarios actualizados de nuestros cursos de idiomas para el verano 2025. Disponibles en nuestro sitio web.",
            media: [],
            mediaMode: null,
            allowComments: true,
            likes: 8,
            comments: 2
        },
        {
            id: 5,
            title: "\u00a1Ap\u00fantate al Club de Conversaci\u00f3n en Ingl\u00e9s!",
            category: "eventos ingles",
            content: "Practica tu ingl\u00e9s todos los viernes con nuestros moderadores nativos. \u00a1Sesiones gratuitas para estudiantes registrados!",
            media: [{ type: "image", url: "https://images.unsplash.com/photo-1515162305281-9de0c5540b98" }],
            mediaMode: "manual",
            allowComments: true,
            likes: 12,
            comments: 3
        },
        {
            id: 6,
            title: "Concurso de Traducci\u00f3n 2025",
            category: "anuncios",
            content: "Demuestra tus habilidades de traducci\u00f3n y gana becas para nuestros cursos avanzados. Inscripciones abiertas hasta el 30 de junio.",
            media: [{ type: "image", url: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b" }],
            mediaMode: "manual",
            allowComments: true,
            likes: 5,
            comments: 0
        },
        {
            id: 7,
            title: "Top 5 Pel\u00edculas para Practicar Franc\u00e9s",
            category: "recursos frances",
            content: "Descubre nuestra selecci\u00f3n de pel\u00edculas francesas con subt\u00edtulos para mejorar tu comprensi\u00f3n auditiva.",
            media: [
                { type: "image", url: "https://images.unsplash.com/photo-1524985069026-dd778a71c7b4" },
                { type: "image", url: "https://images.unsplash.com/photo-1542206395-9feb3edaa68f" }
            ],
            mediaMode: "gallery",
            allowComments: false,
            likes: 18,
            comments: 1
        },
        {
            id: 8,
            title: "\u00a1Nuevo Curso Intensivo de Alem\u00e1n!",
            category: "anuncios aleman",
            content: "Aprende alem\u00e1n en tiempo r\u00e9cord con nuestro curso intensivo de verano. Inicio: 10 de julio. Cupos limitados.",
            media: [{ type: "image", url: "https://images.unsplash.com/photo-1590608897129-79da63ec0201" }],
            mediaMode: "manual",
            allowComments: true,
            likes: 15,
            comments: 4
        },
        {
            id: 9,
            title: "Semana Cultural Japonesa",
            category: "eventos japones",
            content: "\u00danete a las actividades especiales para conocer la cultura japonesa: talleres, comida y charlas. 20 al 25 de julio.",
            media: [
                { type: "image", url: "https://images.unsplash.com/photo-1549693578-d683be217e58" },
                { type: "image", url: "https://images.unsplash.com/photo-1557825835-74ef4e58c313" }
            ],
            mediaMode: "gallery",
            allowComments: true,
            likes: 22,
            comments: 6
        },
        {
            id: 10,
            title: "Gu\u00eda de Pronunciaci\u00f3n en Ingl\u00e9s",
            category: "recursos ingles",
            content: "Descarga nuestra nueva gu\u00eda PDF con ejercicios de pronunciaci\u00f3n y ejemplos de audio.",
            media: [{ type: "image", url: "https://images.unsplash.com/photo-1498050108023-c5249f4df085" }],
            mediaMode: "manual",
            allowComments: false,
            likes: 9,
            comments: 0
        }
    ];

    function renderPosts(posts) {
        publicacionesContainer.innerHTML = '<div class="grid-sizer"></div>';
        posts.forEach(post => {
            const postElement = document.createElement('div');
            postElement.className = 'grid-item animate__animated animate__fadeInUp';
            postElement.setAttribute('data-filter', post.category);

            let mediaHtml = '';
            if (post.media.length) {
                if (post.mediaMode === 'gallery') {
                    mediaHtml = `<div class="preview-media-grid">
                        ${post.media.map(media => `<${media.type} src="${media.url}" ${media.type === 'video' ? 'controls muted' : ''} alt="${post.title}"></${media.type}>`).join('')}
                    </div>`;
                } else {
                    mediaHtml = `
                        <div class="carousel slide" data-bs-ride="${post.mediaMode === 'auto' ? 'carousel' : 'false'}" id="carouselPost${post.id}">
                            <div class="carousel-inner">
                                ${post.media.map((media, index) => `
                                    <div class="carousel-item ${index === 0 ? 'active' : ''}">
                                        <${media.type} src="${media.url}" ${media.type === 'video' ? 'controls muted' : ''} class="d-block w-100" alt="${post.title}"></${media.type}>
                                    </div>
                                `).join('')}
                            </div>
                            ${post.media.length > 1 ? `
                                <button class="carousel-control-prev" type="button" data-bs-target="#carouselPost${post.id}" data-bs-slide="prev">
                                    <span class="carousel-control-prev-icon" aria-hidden="true"></span>
                                    <span class="visually-hidden">Previous</span>
                                </button>
                                <button class="carousel-control-next" type="button" data-bs-target="#carouselPost${post.id}" data-bs-slide="next">
                                    <span class="carousel-control-next-icon" aria-hidden="true"></span>
                                    <span class="visually-hidden">Next</span>
                                </button>
                            ` : ''}
                        </div>`;
                }
            }

            postElement.innerHTML = `
                ${mediaHtml}
                <div class="post-content">
                    <h3>${post.title}</h3>
                    <p>${post.content}</p>
                </div>
                <div class="post-actions">
                    <button class="btn btn-sm btn-outline-primary">
                        <i class="fas fa-heart"></i> ${post.likes} Likes
                    </button>
                    <button class="btn btn-sm btn-outline-primary ${post.allowComments ? '' : 'disabled'}">
                        <i class="fas fa-comment"></i> ${post.allowComments ? `${post.comments} Comentarios` : 'Comentarios Desactivados'}
                    </button>
                </div>
            `;
            publicacionesContainer.appendChild(postElement);
        });

        // Inicializar Masonry
        new Masonry(publicacionesContainer, {
            itemSelector: '.grid-item',
            columnWidth: '.grid-sizer',
            percentPosition: true,
            gutter: 16 // Espacio entre columnas
        });
    }

    // Filtros
    document.querySelectorAll('.filter-button').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.filter-button').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            const filter = button.getAttribute('data-filter');
            const filteredPosts = filter === 'all' ? posts : posts.filter(post => post.category.includes(filter));
            renderPosts(filteredPosts);
        });
    });

    // Renderizar todas las publicaciones al cargar
    renderPosts(posts);
});