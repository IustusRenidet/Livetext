document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('alert-modal')) {
    const modalHtml = `
<div class="modal fade" id="alert-modal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title" id="alert-modal-title">Aviso</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body" id="alert-modal-body"></div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" data-bs-dismiss="modal">Aceptar</button>
      </div>
    </div>
  </div>
</div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }
});

window.showAlert = window.showAlert || function(message, title = 'Aviso') {
  document.getElementById('alert-modal-title').textContent = title;
  document.getElementById('alert-modal-body').textContent = message;
  const modal = new bootstrap.Modal(document.getElementById('alert-modal'));
  modal.show();
};
