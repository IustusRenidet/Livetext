document.addEventListener('DOMContentLoaded', () => {
  const btn = document.createElement('button');
  btn.id = 'accessibilityToggle';
  btn.className = 'btn btn-secondary accessibility-toggle';
  btn.type = 'button';
  btn.textContent = 'Accesibilidad';
  document.body.appendChild(btn);

  const style = document.createElement('style');
  style.textContent = `
  .accessibility-toggle {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 10000;
  }
  .high-contrast, .high-contrast a {
    background-color: #000 !important;
    color: #fff !important;
  }
  `;
  document.head.appendChild(style);

  btn.addEventListener('click', () => {
    document.body.classList.toggle('high-contrast');
    const large = document.body.classList.toggle('large-text');
    document.documentElement.style.fontSize = large ? '125%' : '';
    localStorage.setItem('highContrast', document.body.classList.contains('high-contrast'));
    localStorage.setItem('largeText', large);
  });

  if (localStorage.getItem('highContrast') === 'true') {
    document.body.classList.add('high-contrast');
  }
  if (localStorage.getItem('largeText') === 'true') {
    document.body.classList.add('large-text');
    document.documentElement.style.fontSize = '125%';
  }

  document.querySelectorAll('input[placeholder]:not([aria-label])').forEach(el => {
    el.setAttribute('aria-label', el.placeholder);
  });
  document.querySelectorAll('img:not([alt])').forEach(img => {
    img.setAttribute('alt', '');
  });
});
