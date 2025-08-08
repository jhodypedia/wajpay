// public/js/dashboard.js
$(function(){
  toastr.options = { "positionClass": "toast-bottom-right", "timeOut": 3500 };
  const socket = io();
  let activeSession = 'main'; // default

  // initial UI
  $('#sessionSelect').append(`<option value="main" selected>main</option>`);
  renderTemplates();

  // ask server for sessions
  socket.emit('list-sessions');

  socket.on('connect', ()=> { toastr.success('Realtime connected'); });
  socket.on('disconnect', ()=> { toastr.warning('Realtime disconnected'); });

  socket.on('sessions-list', (rows) => {
    $('#sessionSelect').empty();
    (rows || []).forEach(r => {
      $('#sessionSelect').append(`<option value="${r.session_id}">${r.session_id} — ${r.status}</option>`);
    });
    $('#connectedCount').text('Sessions: ' + (rows?.length||0));
  });

  socket.on('session', (s) => {
    if (!s?.id) return;
    updateOrAddSession(s);
    updateConnectionStatus(s);
  });

  socket.on('qr', (payload) => {
    toastr.info('QR diperbarui untuk session ' + (payload?.id || 'main'));
  });

  socket.on('ready', (p) => {
    toastr.success('Session ready: ' + (p.id || 'main'));
    renderStatusBadge('connected');
    socket.emit('list-sessions');
  });

  socket.on('message', (m) => {
    appendInboxMessage(m.id, m.from, m.text, false);
    addLog(`[IN] ${m.from}: ${m.text}`);
  });

  socket.on('message-sent', (m) => {
    appendInboxMessage(m.id, m.to, m.message, true);
    addLog(`[OUT] ${m.to}: ${m.message}`);
    toastr.success('Pesan terkirim');
  });

  socket.on('broadcast-status', (b) => {
    addLog(`[BCAST] ${b.idx}/${b.total} -> ${b.to} : ${b.status}`);
  });

  socket.on('broadcast-complete', (res) => {
    toastr.success(`Broadcast selesai. sukses: ${res.success}/${res.total}`);
  });

  socket.on('error', (err) => { toastr.error(err || 'Server error'); });

  // UI events
  $('#sessionSelect').on('change', function(){
    activeSession = $(this).val();
    $('#sessionInfo').text('Active: ' + activeSession);
  });

  $('#btnRequestQrMain').click(()=> socket.emit('request-qr', { sessionId: activeSession }));
  $('#btnRefreshSessions').click(()=> socket.emit('list-sessions'));
  $('#btnLogoutSession').click(()=> {
    if (!confirm('Logout session ' + activeSession + '?')) return;
    socket.emit('logout', { sessionId: activeSession });
  });

  $('#btnListSessions').click(()=> socket.emit('list-sessions'));
  $('#btnLogoutAll').click(()=> {
    if (!confirm('Logout all sessions?')) return;
    socket.emit('logout', { sessionId: activeSession }); // backend has logout-all via socket? we have logout-per-session
    toastr.info('Logout requested');
  });

  $('#sendForm').submit(function(e){
    e.preventDefault();
    const to = $('#toInput').val().trim();
    const message = $('#messageInput').val().trim();
    if (!to || !message) return toastr.warning('Nomor dan pesan diperlukan');
    socket.emit('send-message', { sessionId: activeSession, to, message });
    $('#messageInput').val('');
  });

  $('#btnBroadcast').click(()=> $('#modalBroadcast').modal('show'));
  $('#btnDoBroadcast').click(()=> {
    const raw = $('#broadcastNumbers').val().trim();
    const message = $('#broadcastMessage').val().trim();
    if (!raw || !message) return toastr.warning('Numbers and message required');
    const numbers = raw.split(/[,\\n]+/).map(s=>s.trim()).filter(Boolean);
    socket.emit('broadcast', { sessionId: activeSession, numbers, message });
    $('#modalBroadcast').modal('hide');
    addLog(`[BROADCAST] start -> ${numbers.length} numbers`);
  });

  // Templates
  $('#templatesList').on('click', '.tpl-use', function(){
    const txt = $(this).closest('.tpl-item').data('text');
    $('#messageInput').val(txt);
    toastr.info('Template applied');
  });
  $('#btnAddTemplate').click(()=> {
    const title = prompt('Title template');
    const text = prompt('Template text');
    if (title && text) {
      const tpl = { id: Date.now(), title, text };
      addTemplate(tpl);
      toastr.success('Template added');
    }
  });

  // helper UI functions
  function updateOrAddSession(s){
    const opt = $(`#sessionSelect option[value="${s.id}"]`);
    if (opt.length) opt.text(`${s.id} — ${s.status}`);
    else $('#sessionSelect').append(`<option value="${s.id}">${s.id} — ${s.status}</option>`);
    $('#connectedCount').text('Sessions: ' + $('#sessionSelect option').length);
  }

  function updateConnectionStatus(s){
    if (!s?.status) return;
    const st = s.status;
    const badge = (st === 'connected') ? '<span class="badge bg-success">connected</span>' :
                  (st === 'qr_received') ? '<span class="badge bg-warning text-dark">scan QR</span>' :
                  (st === 'logged_out') ? '<span class="badge bg-danger">logged_out</span>' :
                  '<span class="badge bg-secondary">'+st+'</span>';
    $('#waConnectionStatus').html('Status: ' + badge);
  }

  function renderStatusBadge(state){
    if (state === 'connected') $('#waConnectionStatus').html('Status: <span class="badge bg-success">connected</span>');
    else $('#waConnectionStatus').html('Status: <span class="badge bg-secondary">'+state+'</span>');
  }

  function appendInboxMessage(sessionId, from, text, outgoing=false){
    const html = `<div class="list-group-item">
      <div class="d-flex justify-content-between">
        <div><strong>${outgoing? 'You → ' + from : from}</strong><div class="muted small">${text}</div></div>
        <div class="muted small">${new Date().toLocaleTimeString()}</div>
      </div>
    </div>`;
    $('#inbox').prepend(html);
  }

  function addLog(txt){
    const t = new Date().toLocaleString();
    $('#logs').prepend(`[${t}] ${txt}\n`);
  }

  // templates storage (local)
  const TPL_KEY = 'wa_bot_templates_v1';
  function renderTemplates(){
    const stored = JSON.parse(localStorage.getItem(TPL_KEY) || '[]');
    $('#templatesList').empty();
    (stored || []).forEach(t => {
      $('#templatesList').append(`<div class="list-group-item tpl-item d-flex justify-content-between align-items-center" data-text="${t.text}">
        <div><strong>${t.title}</strong><div class="muted small">${t.text.substring(0,80)}${t.text.length>80?'...':''}</div></div>
        <div><button class="btn btn-sm btn-outline-light tpl-use">Use</button></div>
      </div>`);
    });
  }
  function addTemplate(t){
    const stored = JSON.parse(localStorage.getItem(TPL_KEY) || '[]');
    stored.unshift(t);
    localStorage.setItem(TPL_KEY, JSON.stringify(stored));
    renderTemplates();
  }
  // initial render
  renderTemplates();
});
