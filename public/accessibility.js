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
    left: 1rem;
    z-index: 10000;
  }
  .high-contrast, .high-contrast a {
    background-color: #000 !important;
    color: #fff !important;
  }
  `;
  document.head.appendChild(style);

  const readerBtn = document.createElement('button');
  readerBtn.id = 'screenReaderToggle';
  readerBtn.className = 'btn btn-secondary accessibility-toggle ms-2';
  readerBtn.type = 'button';
  readerBtn.textContent = 'Narrador';
  document.body.appendChild(readerBtn);

  function speak(text) {
    if (!window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-MX';
    window.speechSynthesis.speak(utterance);
  }

  let readerEnabled = false;
  readerBtn.addEventListener('click', () => {
    readerEnabled = !readerEnabled;
    readerBtn.setAttribute('aria-pressed', readerEnabled);
    speak(readerEnabled ? 'Narrador activado' : 'Narrador desactivado');
    localStorage.setItem('screenReader', readerEnabled);
  });

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

  if (localStorage.getItem('screenReader') === 'true') {
    readerEnabled = true;
    readerBtn.setAttribute('aria-pressed', 'true');
    speak('Narrador activado');
  }

  document.addEventListener('focusin', e => {
    if (!readerEnabled) return;
    const target = e.target;
    const text = target.getAttribute('aria-label') || target.alt || target.innerText || target.value;
    if (text) speak(text);
  });
});
