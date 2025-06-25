document.addEventListener('DOMContentLoaded', () => {
  const btn = document.createElement('button');
  btn.id = 'accessibilityToggle';
  btn.className = 'btn btn-secondary accessibility-toggle';
  btn.type = 'button';
  btn.textContent = 'Accesibilidad';
  document.body.appendChild(btn);

  const narratorBtn = document.createElement('button');
  narratorBtn.id = 'narratorToggle';
  narratorBtn.className = 'btn btn-secondary accessibility-toggle narrator-toggle';
  narratorBtn.type = 'button';
  narratorBtn.textContent = 'Narrador';
  narratorBtn.setAttribute('aria-pressed', 'false');
  document.body.appendChild(narratorBtn);

  const style = document.createElement('style');
  style.textContent = `
  .accessibility-toggle {
    position: fixed;
    bottom: 6rem;
    right: 1rem;
    z-index: 10000;
  }
  .narrator-toggle {
    right: 6rem;
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

  let narratorEnabled = localStorage.getItem('narratorEnabled') === 'true';
  narratorBtn.setAttribute('aria-pressed', narratorEnabled);

  narratorBtn.addEventListener('click', () => {
    narratorEnabled = !narratorEnabled;
    narratorBtn.setAttribute('aria-pressed', narratorEnabled);
    localStorage.setItem('narratorEnabled', narratorEnabled);
  });

  function speak(text) {
    if (!narratorEnabled || !window.speechSynthesis) return;
    const content = (text || '').trim();
    if (!content) return;
    const utter = new SpeechSynthesisUtterance(content);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  function announce(text) {
    speak(text);
  }

  document.body.addEventListener('focusin', e => {
    const el = e.target;
    const label = el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent;
    speak(label);
  });

  document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', () => {
      announce('Enviando formulario');
    });
  });

  document.querySelectorAll('.toast').forEach(toast => {
    toast.addEventListener('shown.bs.toast', () => {
      const msg = toast.querySelector('.toast-body')?.textContent;
      if (msg) announce(msg);
    });
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
    img.setAttribute('alt', 'imagen sin descripcion');
  });
});
