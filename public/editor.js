// editor.js
// All required libraries are included via CDN in editor.html, so we rely on
// the global variables they expose instead of using ES module imports. This
// keeps the script simple and avoids the need for a build step.

// Initialize global variables
window.editors = [];
window.currentPage = 0;
window.pages = [{ content: [], header: [], footer: [] }];
window.pageSettings = {
  size: 'A4',
  orientation: 'portrait',
  margins: { top: 10, bottom: 10, left: 10, right: 10 },
  numbering: 'none',
  startNumber: 1,
  customFormat: ''
};
let selectedElement = null;
let isDragging = false;
let isResizing = false;
let dragStart = { x: 0, y: 0 };
let elementStart = { x: 0, y: 0 };
let autofillFields = [];
let excelRows = [];

// Page dimensions in mm
const pageSizes = {
  'Carta': { width: 215.9, height: 279.4 },
  'Oficio': { width: 215.9, height: 355.6 },
  'A4': { width: 210, height: 297 }
};

// Initialize Editor.js for a specific page
window.initializeEditor = function(pageIndex) {
  const editor = new EditorJS({
    holder: `editor-page-${pageIndex}`,
    tools: {
      header: {
        class: Header,
        config: { levels: [1, 2, 3], defaultLevel: 1 }
      },
      list: List,
      image: {
        class: ImageTool,
        config: {
          endpoints: {
            byFile: '/api/upload-image'
          }
        }
      },
      table: Table
    },
    data: pages[pageIndex].content,
    onChange: () => {
      editor.save().then((output) => {
        pages[pageIndex].content = output;
      });
    }
  });
  editors[pageIndex] = editor;
};

// Add a new page
$('#new-page-btn').on('click', () => {
  const newPageIndex = pages.length;
  pages.push({ content: [], header: [], footer: [] });
  const pageHtml = `
    <div class="page" id="page-${newPageIndex}" style="display: none;">
      <div class="header" contenteditable="false"></div>
      <div id="editor-page-${newPageIndex}" class="editor-content"></div>
      <div class="footer" contenteditable="false"></div>
    </div>
  `;
  $('#editor-container').append(pageHtml);
  initializeEditor(newPageIndex);
  switchPage(newPageIndex);
  updatePageStyles(newPageIndex);
});

// Switch between pages
window.switchPage = function(pageIndex) {
  $('.page').hide();
  $(`#page-${pageIndex}`).show();
  currentPage = pageIndex;
  updatePageStyles(pageIndex);
};

// Update page styles based on settings
window.updatePageStyles = function(pageIndex) {
  const { size, orientation, margins } = pageSettings;
  const dimensions = pageSizes[size];
  const page = $(`#page-${pageIndex}`);
  page.css({
    width: `${orientation === 'portrait' ? dimensions.width : dimensions.height}mm`,
    height: `${orientation === 'portrait' ? dimensions.height : dimensions.width}mm`,
    marginTop: `${margins.top}mm`,
    marginBottom: `${margins.bottom}mm`,
    marginLeft: `${margins.left}mm`,
    marginRight: `${margins.right}mm`
  });
  updatePageNumbering(pageIndex);
};

// Update page numbering
window.updatePageNumbering = function(pageIndex) {
  const { numbering, startNumber, customFormat } = pageSettings;
  const footer = $(`#page-${pageIndex} .footer`);
  let numberText = '';
  if (numbering !== 'none') {
    const pageNum = startNumber + pageIndex;
    switch (numbering) {
      case 'numeric':
        numberText = pageNum;
        break;
      case 'page-x':
        numberText = `Page ${pageNum}`;
        break;
      case 'page-x-of-y':
        numberText = `Page ${pageNum} of ${pages.length}`;
        break;
      case 'roman':
        numberText = toRoman(pageNum);
        break;
      case 'custom':
        numberText = customFormat
          .replace('{n}', pageNum)
          .replace('{y}', pages.length);
        break;
    }
    footer.find('.page-number').text(numberText);
  }
};

// Convert number to Roman numerals
function toRoman(num) {
  const roman = {
    M: 1000, CM: 900, D: 500, CD: 400,
    C: 100, XC: 90, L: 50, XL: 40,
    X: 10, IX: 9, V: 5, IV: 4, I: 1
  };
  let result = '';
  for (let key in roman) {
    while (num >= roman[key]) {
      result += key;
      num -= roman[key];
    }
  }
  return result;
}

// Drag-and-drop elements
$('.element-icon').draggable({
  helper: 'clone',
  revert: 'invalid',
  appendTo: 'body', // Append drag helper to body to escape sidebar constraints
  zIndex: 10000, // Ensure helper is above all elements
  scroll: false, // Disable auto-scroll to prevent sidebar interference
  start: function (event, ui) {
    ui.helper.addClass('animate__animated animate__pulse');
    ui.helper.css({
      width: $(this).width(),
      height: $(this).height()
    });
  },
  stop: function (event, ui) {
    ui.helper.removeClass('animate__animated animate__pulse');
  }
});

$('.editor-content').droppable({
  accept: '.element-icon',
  tolerance: 'pointer', // Improve drop accuracy
  drop: function (event, ui) {
    const type = ui.draggable.data('type');
    const editorIndex = $(this).attr('id').split('-')[2];
    addElement(type, event, editorIndex);
  },
  over: function (event, ui) {
    $(this).addClass('dropzone-active'); // Visual feedback
  },
  out: function (event, ui) {
    $(this).removeClass('dropzone-active');
  }
});

// Add elements to the editor
window.addElement = function(type, event, editorIndex) {
  const editor = editors[parseInt(editorIndex)];
  if (!editor) return;
  try {
    switch (type) {
      case 'text':
        editor.blocks.insert('paragraph', { text: 'New Text' });
        break;
      case 'heading':
        editor.blocks.insert('header', { text: 'New Heading', level: 1 });
        break;
      case 'image':
        editor.blocks.insert('image', { url: '/placeholder.png' });
        break;
      case 'table':
        $('#table-modal').modal('show');
        break;
      case 'chart':
        $('#chart-modal').modal('show');
        break;
      case 'list':
        editor.blocks.insert('list', { style: 'unordered', items: ['Item 1'] });
        break;
      default:
        console.warn(`Unsupported element type: ${type}`);
    }
  } catch (error) {
    console.error('Error adding element:', error);
    alert('Failed to add element.');
  }
};

// Table modal handling
$('#create-table-btn').on('click', () => {
  const rows = parseInt($('#table-rows').val());
  const cols = parseInt($('#table-columns').val());
  const includeHeader = $('#table-header').is(':checked');
  if (rows < 1 || cols < 1) {
    alert('Rows and columns must be at least 1.');
    return;
  }
  const data = includeHeader
    ? [Array(cols).fill('Header'), ...Array(rows - 1).fill(Array(cols).fill('Cell'))]
    : Array(rows).fill(Array(cols).fill('Cell'));
  editors[currentPage].blocks.insert('table', { content: data });
  $('#table-modal').modal('hide');
});

// Chart modal handling
$('#create-chart-btn').on('click', () => {
  const type = $('#chart-type').val();
  const data = $('.chart-data').map((i, el) => ({
    label: $(el).find('.chart-label').val(),
    value: parseFloat($(el).find('.chart-value').val()) || 0
  })).get();
  if (data.length === 0) {
    alert('At least one data point is required.');
    return;
  }
  const chartCanvas = document.createElement('canvas');
  new Chart(chartCanvas, {
    type: type,
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        data: data.map(d => d.value),
        backgroundColor: ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0']
      }]
    }
  });
  editors[currentPage].blocks.insert('image', { url: chartCanvas.toDataURL() });
  $('#chart-modal').modal('hide');
});

// Header/footer editing
$('#edit-header-btn').on('click', () => {
  const header = $(`#page-${currentPage} .header`);
  header.attr('contenteditable', true).focus();
  header.addClass('editing animate__animated animate__pulse');
});

$('#edit-footer-btn').on('click', () => {
  const footer = $(`#page-${currentPage} .footer`);
  footer.attr('contenteditable', true).focus();
  footer.addClass('editing animate__animated animate__pulse');
});

// Save header/footer content
$('.header, .footer').on('blur', function () {
  $(this).attr('contenteditable', false).removeClass('editing animate__animated animate__pulse');
  const pageIndex = $(this).closest('.page').attr('id').split('-')[1];
  const isHeader = $(this).hasClass('header');
  const content = sanitizeHtml($(this).html());
  if (isHeader) {
    pages[pageIndex].header = content;
  } else {
    pages[pageIndex].footer = content;
  }
});

// Page configuration modal
$('#page-numbering').on('change', function () {
  $('#custom-format-container').toggle($(this).val() === 'custom');
});

$('#apply-page-config-btn').on('click', () => {
  const margins = {
    top: parseFloat($('#margin-top').val()) || 10,
    bottom: parseFloat($('#margin-bottom').val()) || 10,
    left: parseFloat($('#margin-left').val()) || 10,
    right: parseFloat($('#margin-right').val()) || 10
  };
  if (margins.top < 10 || margins.bottom < 10 || margins.left < 10 || margins.right < 10) {
    alert('Margins must be at least 10mm.');
    return;
  }
  pageSettings = {
    size: $('#page-size').val(),
    orientation: $('#page-orientation').val(),
    margins: margins,
    numbering: $('#page-numbering').val(),
    startNumber: parseInt($('#start-number').val()) || 1,
    customFormat: $('#custom-format').val()
  };
  pages.forEach((_, i) => updatePageStyles(i));
  $('#page-config-modal').modal('hide');
});

// Preview mode
$('#preview-btn').on('click', () => {
  const isPreview = $('#editor-container').hasClass('preview-mode');
  $('#editor-container').toggleClass('preview-mode');
  $('#preview-btn').html(isPreview ? '<i class="fas fa-eye me-2"></i>Modo Vista Previa' : '<i class="fas fa-edit me-2"></i>Modo Edición');
  if (isPreview) {
    $('#editor-container').removeClass('preview-mode animate__animated animate__fadeOut');
    $('.toolbar, .sidebar, .navbar').show();
  } else {
    $('#editor-container').addClass('preview-mode animate__animated animate__fadeIn');
    $('.toolbar, .sidebar, .navbar').hide();
  }
});

// Save document
$('#save-btn').on('click', async () => {
  const title = prompt('Enter document title:');
  if (!title) {
    alert('Title is required.');
    return;
  }
  const documentData = {
    title: sanitizeHtml(title),
    pages: pages.map(page => ({
      content: page.content,
      header: page.header,
      footer: page.footer,
      orientation: pageSettings.orientation,
      size: pageSettings.size
    })),
    settings: pageSettings,
    autofillFields: autofillFields
  };
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const docId = urlParams.get('id');
    const templateId = urlParams.get('templateId');
    let response;
    if (docId) {
      response = await fetch(`/api/documents/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(documentData)
      });
    } else {
      response = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(documentData)
      });
    }
    if (!response.ok) throw new Error('Failed to save document.');
    const result = await response.json();
    const element = document.getElementById('editor-container');
    await html2pdf()
      .set({
        margin: [pageSettings.margins.top, pageSettings.margins.right, pageSettings.margins.bottom, pageSettings.margins.left],
        filename: `${title}.pdf`,
        jsPDF: { unit: 'mm', format: pageSettings.size.toLowerCase(), orientation: pageSettings.orientation }
      })
      .from(element)
      .save();
    alert('Document saved and exported as PDF.');
    updateDashboard(title, new Date());
  } catch (error) {
    console.error('Error saving document:', error);
    alert('Failed to save document.');
  }
});

// Save template
$('#save-template-btn').on('click', async () => {
  const title = prompt('Ingrese el título de la plantilla:');
  if (!title) {
    alert('El título es obligatorio.');
    return;
  }
  const documentData = {
    title: sanitizeHtml(title),
    pages: pages.map(page => ({
      content: page.content,
      header: page.header,
      footer: page.footer,
      orientation: pageSettings.orientation,
      size: pageSettings.size
    })),
    settings: pageSettings,
    autofillFields: autofillFields
  };
  try {
    const response = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(documentData)
    });
    if (!response.ok) throw new Error('Failed to save template.');
    alert('Plantilla guardada exitosamente.');
    updateDashboard(title, new Date());
  } catch (error) {
    console.error('Error saving template:', error);
    alert('Error al guardar la plantilla.');
  }
});

// Load document or template
window.loadDocument = async function() {
  const urlParams = new URLSearchParams(window.location.search);
  const docId = urlParams.get('id');
  const templateId = urlParams.get('templateId');
  try {
    let response;
    if (docId) {
      response = await fetch(`/api/documents/${docId}`);
    } else if (templateId) {
      response = await fetch(`/api/templates/${templateId}`);
    }
    if (response && response.ok) {
      const data = await response.json();
      pages = data.pages;
      pageSettings = data.settings;
      autofillFields = data.autofillFields || [];
      pages.forEach((page, i) => {
        const pageHtml = `
          <div class="page" id="page-${i}">
            <div class="header" contenteditable="false">${page.header}</div>
            <div id="editor-page-${i}" class="editor-content"></div>
            <div class="footer" contenteditable="false">${page.footer}</div>
          </div>
        `;
        $('#editor-container').append(pageHtml);
        initializeEditor(i);
        updatePageStyles(i);
      });
      switchPage(0);
    } else {
      initializeEditor(0);
    }
  } catch (error) {
    console.error('Error loading document:', error);
    alert('Failed to load document. Starting with a blank page.');
    initializeEditor(0);
  }
};

// Update dashboard_documentos.html
window.updateDashboard = function(title, lastModified) {
  const docItem = `
    <div class="col-md-4 col-sm-6">
      <div class="card">
        <div class="card-body">
          <h5 class="card-title">${sanitizeHtml(title)}</h5>
          <p class="card-text">Última modificación: ${moment(lastModified).format('DD/MM/YYYY')}</p>
          <a href="#" class="btn btn-primary">Abrir</a>
        </div>
      </div>
    </div>
  `;
  $('#recent-documents').prepend(docItem);
};

// Responsive design adjustments
window.adjustForMobile = function() {
  if (window.innerWidth < 768) {
    $('.sidebar').addClass('collapse');
    $('#sidebar-toggle').show();
  } else {
    $('.sidebar').removeClass('collapse');
    $('#sidebar-toggle').hide();
  }
};

$(window).on('resize', adjustForMobile);
adjustForMobile();

// Toolbar formatting
$('.format-btn').on('click', function () {
  const command = $(this).data('command');
  document.execCommand(command, false, null);
});

$('#font-select').on('change', function () {
  document.execCommand('fontName', false, $(this).val());
});

$('#size-select').on('change', function () {
  document.execCommand('fontSize', false, $(this).val());
});

// Header/Footer interactions
function setupHeaderFooterInteractions(container) {
  const elements = container.find('.header-element, .footer-element');
  elements.each(function () {
    const $this = $(this);
    makeElementDraggable($this);
    makeElementResizable($this);
    makeElementSelectable($this);
  });
}

function makeElementDraggable(element) {
  element.off('mousedown.drag').on('mousedown.drag', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if ($(e.target).hasClass('resize-handle')) return;
    selectedElement = element;
    isDragging = true;
    element.addClass('selected').siblings().removeClass('selected');
    const offset = element.offset();
    const containerOffset = element.parent().offset();
    dragStart.x = e.pageX;
    dragStart.y = e.pageY;
    elementStart.x = offset.left - containerOffset.left;
    elementStart.y = offset.top - containerOffset.top;
    $(document).on('mousemove.drag', function (e) {
      if (!isDragging) return;
      const deltaX = e.pageX - dragStart.x;
      const deltaY = e.pageY - dragStart.y;
      const newX = Math.max(0, elementStart.x + deltaX);
      const newY = Math.max(0, elementStart.y + deltaY);
      element.css({ left: newX + 'px', top: newY + 'px' });
    });
    $(document).on('mouseup.drag', function () {
      isDragging = false;
      $(document).off('mousemove.drag mouseup.drag');
    });
  });
}

function makeElementResizable(element) {
  if (!element.find('.resize-handle').length) {
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    handles.forEach(handle => {
      element.append(`<div class="resize-handle ${handle}"></div>`);
    });
  }
  element.find('.resize-handle').off('mousedown.resize').on('mousedown.resize', function (e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    const handle = $(this);
    const direction = handle.attr('class').split(' ')[1];
    const startWidth = element.width();
    const startHeight = element.height();
    const startX = e.pageX;
    const startY = e.pageY;
    const startLeft = parseInt(element.css('left'));
    const startTop = parseInt(element.css('top'));
    $(document).on('mousemove.resize', function (e) {
      const deltaX = e.pageX - startX;
      const deltaY = e.pageY - startY;
      let newWidth = startWidth;
      let newHeight = startHeight;
      let newLeft = startLeft;
      let newTop = startTop;
      if (direction.includes('e')) newWidth = Math.max(20, startWidth + deltaX);
      if (direction.includes('w')) {
        newWidth = Math.max(20, startWidth - deltaX);
        newLeft = startLeft + deltaX;
      }
      if (direction.includes('s')) newHeight = Math.max(20, startHeight + deltaY);
      if (direction.includes('n')) {
        newHeight = Math.max(20, startHeight - deltaY);
        newTop = startTop + deltaY;
      }
      element.css({
        width: newWidth + 'px',
        height: newHeight + 'px',
        left: newLeft + 'px',
        top: newTop + 'px'
      });
    });
    $(document).on('mouseup.resize', function () {
      isResizing = false;
      $(document).off('mousemove.resize mouseup.resize');
    });
  });
}

function makeElementSelectable(element) {
  element.off('click.select').on('click.select', function (e) {
    e.stopPropagation();
    $('.header-element, .footer-element').removeClass('selected');
    element.addClass('selected');
    selectedElement = element;
  });
}

$('.add-header-image, .add-footer-image').on('click', function () {
  const isHeader = $(this).hasClass('add-header-image');
  const container = isHeader ? $('.header .header-content') : $('.footer .footer-content');
  const input = $('<input type="file" accept="image/*">');
  input.on('change', function (e) {
    const file = e.target.files[0];
    if (file) {
      const formData = new FormData();
      formData.append('image', file);
      $.ajax({
        url: '/api/upload-image',
        type: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        success: function (response) {
          const imageElement = $(`
            <div class="${isHeader ? 'header-element' : 'footer-element'}" style="position: absolute; top: 20px; left: 50px; width: 100px; height: 50px;">
              <img src="${response.url}" class="${isHeader ? 'header-image' : 'footer-image'}" style="width: 100%; height: 100%; object-fit: contain;">
            </div>
          `);
          container.append(imageElement);
          setupHeaderFooterInteractions(container.closest('.header, .footer'));
        },
        error: function () {
          alert('Error al cargar la imagen.');
        }
      });
    }
  });
  input.click();
});

$('.add-header-text, .add-footer-text').on('click', function () {
  const isHeader = $(this).hasClass('add-header-text');
  const container = isHeader ? $('.header .header-content') : $('.footer .footer-content');
  const textElement = $(`
    <div class="${isHeader ? 'header-element' : 'footer-element'}" style="position: absolute; top: 30px; left: 200px; width: 200px; height: 30px;">
      <textarea class="${isHeader ? 'header-text' : 'footer-text'}" style="width: 100%; height: 100%; resize: none; border: none; background: transparent;">Nuevo texto</textarea>
    </div>
  `);
  container.append(textElement);
  setupHeaderFooterInteractions(container.closest('.header, .footer'));
});

$('.header-alignment, .footer-alignment').on('click', function () {
  if (selectedElement) {
    const container = selectedElement.closest('.header, .footer');
    const containerWidth = container.width();
    const elementWidth = selectedElement.width();
    const centerX = (containerWidth - elementWidth) / 2;
    selectedElement.css('left', centerX + 'px');
  }
});

$(document).on('click', function (e) {
  if (!$(e.target).closest('.header, .footer, .header-controls').length) {
    $('.header, .footer').removeClass('editing');
    $('.header-element, .footer-element').removeClass('selected');
    selectedElement = null;
  }
});

$(document).on('keydown', function (e) {
  if (e.key === 'Delete' && selectedElement) {
    selectedElement.remove();
    selectedElement = null;
  }
});

// Add Chart Data
$('#add-chart-data').on('click', function () {
  $('#chart-data-container').append(`
    <div class="chart-data input-group mb-2">
      <input type="text" class="form-control chart-label" placeholder="Etiqueta">
      <input type="number" class="form-control chart-value" placeholder="Valor">
      <button class="btn btn-outline-danger remove-data">×</button>
    </div>
  `);
});

$('#chart-data-container').on('click', '.remove-data', function () {
  $(this).closest('.input-group').remove();
});

// Sidebar Toggle
$('#sidebar-toggle').on('click', function () {
  $('.sidebar').toggleClass('show');
  $('.sidebar').addClass('animate__animated animate__slideInLeft');
  setTimeout(() => $('.sidebar').removeClass('animate__animated animate__slideInLeft'), 500);
});

// Page Orientation Toggle
$('.toggle-orientation').on('click', function () {
  const page = $(this).closest('.page');
  page.toggleClass('landscape');
  const pageIndex = page.attr('id').split('-')[1];
  pageSettings.orientation = page.hasClass('landscape') ? 'landscape' : 'portrait';
  updatePageStyles(pageIndex);
  page.addClass('animate__animated animate__pulse');
  setTimeout(() => page.removeClass('animate__animated animate__pulse'), 500);
});

// Autofill Field Logic
$('#add-autofill-btn').on('click', function () {
  $('#autofill-modal').modal('show');
});

$('#create-autofill-btn').on('click', function () {
  const name = $('#autofill-name').val().trim();
  if (!name) {
    alert('El nombre del campo es obligatorio.');
    return;
  }
  if (autofillFields.includes(name)) {
    alert('El nombre del campo ya existe.');
    return;
  }
  autofillFields.push(name);
  editors[currentPage].blocks.insert('paragraph', {
    text: `<span class="autofill-field" data-field="${name}">[${name}]</span>`
  });
  $('#autofill-modal').modal('hide');
  $('#autofill-name').val('');
});

// Batch Generation Logic
$('#batch-generate-btn').on('click', function () {
  $('#fill-document-btn').hide();
  $('#generate-batch-btn').show();
  $('#batch-generate-modal').modal('show');
  populateAutofillMappings();
});

$('#fill-from-excel-btn').on('click', function () {
  $('#generate-batch-btn').hide();
  $('#fill-document-btn').show();
  $('#batch-generate-modal').modal('show');
  populateAutofillMappings();
});

function populateAutofillMappings() {
  const $mappings = $('#autofill-mappings');
  $mappings.empty();
  if (autofillFields.length === 0) {
    $mappings.append('<p>No hay campos autofill definidos.</p>');
    return;
  }
  autofillFields.forEach(field => {
    $mappings.append(`
      <div class="mb-3">
        <label for="map-${field}" class="form-label">Mapear "${field}" a columna:</label>
        <select class="form-select" id="map-${field}"></select>
      </div>
    `);
  });
}

$('#excel-file').on('change', function (e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const headers = json[0];
      excelRows = json.slice(1);
      $('.form-select', '#autofill-mappings').each(function () {
        const $select = $(this);
        $select.empty().append('<option value="">Seleccione columna</option>');
        headers.forEach((header, index) => {
          $select.append(`<option value="${index}">${header}</option>`);
        });
      });
    };
    reader.readAsArrayBuffer(file);
  }
});

$('#generate-batch-btn').on('click', async function () {
  const fileInput = $('#excel-file')[0];
  if (!fileInput.files.length) {
    alert('Por favor, cargue un archivo Excel.');
    return;
  }
  const mappings = {};
  let valid = true;
  autofillFields.forEach(field => {
    const columnIndex = $(`#map-${field}`).val();
    if (!columnIndex) {
      alert(`Por favor, asigne una columna para el campo "${field}".`);
      valid = false;
    }
    mappings[field] = parseInt(columnIndex);
  });
  if (!valid) return;

  const file = fileInput.files[0];
  const reader = new FileReader();
  reader.onload = async function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const rows = json.slice(1); // Skip header row

    const zip = new JSZip();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const element = document.createElement('div');
      const style = document.createElement('style');
      style.textContent = `
        .document-page { position: relative; margin: 0; background: #fff; }
        .document-page.Carta.portrait { width: 215.9mm; min-height: 279.4mm; }
        .document-page.Carta.landscape { width: 279.4mm; min-height: 215.9mm; }
        .document-page.Oficio.portrait { width: 215.9mm; min-height: 355.6mm; }
        .document-page.Oficio.landscape { width: 355.6mm; min-height: 215.9mm; }
        .document-page.A4.portrait { width: 210mm; min-height: 297mm; }
        .document-page.A4.landscape { width: 297mm; min-height: 210mm; }
        .page-header { position: absolute; top: 0; left: 0; right: 0; height: 50mm; }
        .page-footer { position: absolute; bottom: 0; left: 0; right: 0; height: 20mm; }
        .content-area { margin: 60mm ${pageSettings.margins.right}mm 30mm ${pageSettings.margins.left}mm; }
        .header-element, .footer-element { position: absolute; }
        .header-image, .footer-image { max-width: 100%; height: auto; }
        table { width: 100%; border-collapse: collapse; }
        td, th { border: 1px solid #000; padding: 5px; }
        .chart-container { height: 300px; }
        .image-container img { max-width: 100%; height: auto; }
        .page-number { font-size: 12px; color: #6c757d; }
        .header-content, .footer-content { position: relative; height: 100%; }
        .autofill-field { display: inline; }
      `;
      element.appendChild(style);

      $('.page').each(function (pageIndex) {
        const pageClone = $(this).clone();
        pageClone.find('.autofill-field').each(function () {
          const field = $(this).data('field');
          const columnIndex = mappings[field];
          const value = row[columnIndex] || '';
          $(this).text(value);
        });
        pageClone
          .removeClass('animate__animated animate__fadeInUp')
          .addClass(`${pageSettings.size} ${$(this).hasClass('landscape') ? 'landscape' : 'portrait'}`)
          .css({ 'position': 'relative', 'top': '0', 'left': '0' });
        pageClone.find('.page-controls, .header-controls, .resize-handle').remove();
        pageClone.find('.header, .footer').removeClass('editing');
        pageClone.find('.header-element, .footer-element').removeClass('selected');
        $(element).append(pageClone);
      });

      const opt = {
        margin: [pageSettings.margins.top, pageSettings.margins.right, pageSettings.margins.bottom, pageSettings.margins.left],
        filename: `document-${i + 1}.pdf`,
        image: { type: 'jpeg', quality: 1 },
        html2canvas: { scale: 2, useCORS: true, scrollY: 0 },
        jsPDF: {
          unit: 'mm',
          format: pageSettings.size.toLowerCase(),
          orientation: pageSettings.orientation,
          putOnlyUsedFonts: true
        },
        pagebreak: { mode: ['css', 'legacy'] }
      };

      const pdf = await html2pdf().from(element).set(opt).output('arraybuffer');
      zip.file(`document-${i + 1}.pdf`, pdf);
    }

    zip.generateAsync({ type: 'blob' }).then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'batch_documents.zip';
      a.click();
      URL.revokeObjectURL(url);
    });

    $('#batch-generate-modal').modal('hide');
  };
  reader.readAsArrayBuffer(file);
});

$('#fill-document-btn').on('click', async function () {
  if (!excelRows.length) {
    alert('Por favor, cargue un archivo Excel.');
    return;
  }
  const mappings = {};
  let valid = true;
  autofillFields.forEach(field => {
    const columnIndex = $(`#map-${field}`).val();
    if (!columnIndex) {
      alert(`Por favor, asigne una columna para el campo "${field}".`);
      valid = false;
    }
    mappings[field] = parseInt(columnIndex);
  });
  if (!valid) return;

  const row = excelRows[0];
  $('.page').each(function (pageIndex) {
    $(this).find('.autofill-field').each(function () {
      const field = $(this).data('field');
      const value = row[mappings[field]] || '';
      $(this).text(value);
    });
    editors[pageIndex].save().then(output => {
      pages[pageIndex].content = output;
    });
  });

  $('#batch-generate-modal').modal('hide');
});

// Initialize on page load
$(document).ready(() => {
  loadDocument();
  switchPage(0);
});