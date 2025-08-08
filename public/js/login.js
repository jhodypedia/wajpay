// public/js/login.js
$(function(){
  toastr.options = { "positionClass": "toast-bottom-right", "timeOut": 3000 };
  const socket = io();

  const sessionInput = $('#sessionInput');
  const DEFAULT_SESSION = sessionInput.val() || 'main';

  function startSession(sid = DEFAULT_SESSION) {
    socket.emit('start-session', { sessionId: sid });
    log(`Requested start-session: ${sid}`);
    $('#btnRequestQr').prop('disabled', true);
    setTimeout(()=> $('#btnRequestQr').prop('disabled', false), 2000);
  }

  // auto-start on load with default session
  startSession(DEFAULT_SESSION);

  socket.on('qr', (payload) => {
    const data = (payload && payload.qr) ? payload.qr : payload;
    $('#qrBox').html(`<img src="${data}" style="max-width:240px;"/>`);
    $('#statusBadge').removeClass().addClass('badge bg-warning').text('QR ready');
    $('#statusText').text('Silakan scan QR dengan WhatsApp di HP');
    toastr.info('QR diperbarui — scan sekarang');
    $('#btnGoDashboard').prop('disabled', false);
  });

  socket.on('ready', (payload) => {
    const id = payload?.id || payload?.user?.id || DEFAULT_SESSION;
    toastr.success('WhatsApp connected ('+id+') — redirecting...');
    $('#statusBadge').removeClass().addClass('badge bg-success').text('Connected');
    $('#statusText').text('Tersambung');
    setTimeout(() => window.location.href = '/dashboard.html', 800);
  });

  socket.on('session', (s) => {
    // update sessions list or a single session
    const id = s?.id;
    if (!id) return;
    const itemHtml = `<div class="list-group-item d-flex justify-content-between align-items-center" data-id="${id}">
      <div><strong>${id}</strong><div class="muted small">${s.phone_number || ''}</div></div>
      <div class="muted small">${s.status || ''}</div>
    </div>`;
    const existing = $(`#sessionsList [data-id="${id}"]`);
    if (existing.length) existing.replaceWith(itemHtml);
    else $('#sessionsList').prepend(itemHtml);
  });

  socket.on('sessions-list', (rows) => {
    $('#sessionsList').empty();
    (rows||[]).forEach(r => {
      $('#sessionsList').append(`<div class="list-group-item d-flex justify-content-between align-items-center" data-id="${r.session_id}">
        <div><strong>${r.session_id}</strong><div class="muted small">${r.phone_number||''}</div></div>
        <div class="muted small">${r.status}</div>
      </div>`);
    });
    $('#connectedCount').text('Sessions: ' + (rows?.length||0));
  });

  socket.on('error', (err) => { toastr.error(err || 'Error dari server'); });

  // UI buttons
  $('#btnRequestQr').click(()=> startSession(sessionInput.val() || 'main'));
  $('#btnGoDashboard, #btnGoDashboard2').click(()=> window.location.href = '/dashboard.html');
  $('#btnRefresh').click(()=> socket.emit('list-sessions'));

  function log(m){ console.log('[login] ', m); }
});
