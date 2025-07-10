// Utility functions shared across pages
window.showAlert = function(message, title = 'Aviso') {
  const titleEl = document.getElementById('alert-modal-title');
  const bodyEl = document.getElementById('alert-modal-body');
  if (!titleEl || !bodyEl) return alert(message); // fallback
  titleEl.textContent = title;
  bodyEl.textContent = message;
  const modal = new bootstrap.Modal(document.getElementById('alert-modal'));
  modal.show();
};
