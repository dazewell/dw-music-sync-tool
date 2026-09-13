const $ = (selector) => document.querySelector(selector);
const state = { playlists: [], key: sessionStorage.getItem('soundiizApiKey') || '', poller: null };
const apiKeyInput = $('#apiKey');
const playlistList = $('#playlistList');
const backupButton = $('#backupButton');
apiKeyInput.value = state.key;

function headers(json = false) { return { ...(json ? { 'Content-Type':'application/json' } : {}), ...(state.key ? { 'x-api-key':state.key } : {}) }; }
async function request(url, options = {}) { const response = await fetch(url, { ...options, headers:{ ...headers(Boolean(options.body)), ...options.headers } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || data.message || 'Request failed'); return data; }
function notice(message = '') { const el = $('#notice'); el.textContent = message; el.hidden = !message; }
function selectedIds() { return [...document.querySelectorAll('.playlist input:checked')].map((input) => input.value); }
function syncButton() { backupButton.disabled = !state.key || selectedIds().length === 0; backupButton.textContent = selectedIds().length ? `Back up selected (${selectedIds().length})` : 'Back up selected'; }
function loadingPlaylists() { playlistList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'; }
function renderPlaylists() {
  if (!state.playlists.length) { playlistList.innerHTML = '<div class="empty"><strong>No playlists found</strong><span>Try another platform or check the connected account.</span></div>'; }
  else playlistList.innerHTML = state.playlists.map((p) => `<label class="playlist"><input type="checkbox" value="${escapeHtml(p.id)}"><span><strong>${escapeHtml(p.title)}</strong><small>${Number.isFinite(p.tracksCount) ? `${p.tracksCount} tracks` : 'Track count unavailable'}</small></span><span class="platform-tag">${escapeHtml(p.platform || 'unknown')}</span></label>`).join('');
  $('#playlistSummary').textContent = `${state.playlists.length} playlist${state.playlists.length === 1 ? '' : 's'} available`;
  $('#selectAll').disabled = !state.playlists.length;
  playlistList.querySelectorAll('input').forEach((input) => input.addEventListener('change', syncButton));
  syncButton();
}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }
async function loadPlaylists() { loadingPlaylists(); const data = await request(`/api/playlists?platform=${encodeURIComponent($('#platform').value)}`); state.playlists = data.playlists; renderPlaylists(); }
async function connect(event) { event?.preventDefault(); notice(); state.key = apiKeyInput.value.trim(); sessionStorage.setItem('soundiizApiKey', state.key); const badge = $('#connectionBadge'); badge.textContent = ' Checking connection…'; try { const data = await request('/api/status'); badge.innerHTML = `<span></span> Connected${data.user?.username ? ` as ${escapeHtml(data.user.username)}` : ''}`; badge.classList.add('connected'); await loadPlaylists(); } catch (error) { badge.innerHTML = '<span></span> Connection failed'; badge.classList.remove('connected'); notice(error.message); renderPlaylists(); } }
async function loadHistory() { try { const { backups } = await request('/api/backups/history'); const list = $('#historyList'); if (!backups.length) { list.innerHTML = '<div class="empty"><strong>No backups yet</strong><span>Your completed runs will appear here.</span></div>'; return; } list.innerHTML = backups.map((backup) => `<article class="history-row"><time>${new Date(backup.timestamp).toLocaleString()}</time><div class="history-meta">${backup.successfulPlaylists ?? 0} playlists · ${backup.totalTracks ?? 0} tracks<br>${escapeHtml(backup.format || '')} · ${escapeHtml(backup.platform || '')}</div><div class="file-links">${backup.files.map((file) => `<a href="${file.downloadUrl}">${escapeHtml(file.name)}</a>`).join('')}</div></article>`).join(''); } catch (error) { notice(error.message); } }
function updateProgress(status) { const panel = $('#progressPanel'); panel.hidden = false; $('#progress').value = status.percent; $('#progressPercent').textContent = `${status.percent}%`; $('#progressTitle').textContent = status.state === 'completed' ? 'Backup complete' : status.state === 'failed' ? 'Backup failed' : 'Backing up playlists'; $('#progressMessage').textContent = status.message || status.playlistName || 'Working…'; if (status.state !== 'running') { clearInterval(state.poller); state.poller = null; backupButton.disabled = false; if (status.state === 'completed') loadHistory(); } }
async function pollStatus() { try { updateProgress(await request('/api/backup/status')); } catch (error) { clearInterval(state.poller); state.poller = null; notice(error.message); } }
async function startBackup(event) { event.preventDefault(); notice(); backupButton.disabled = true; try { await request('/api/backup', { method:'POST', body:JSON.stringify({ platform:$('#platform').value, format:$('#format').value, outputDir:$('#outputDir').value, playlistIds:selectedIds() }) }); updateProgress({ state:'running', percent:0, message:'Loading playlists…' }); state.poller = setInterval(pollStatus, 600); } catch (error) { notice(error.message); syncButton(); } }
$('#connectionForm').addEventListener('submit', connect);
$('#backupForm').addEventListener('submit', startBackup);
$('#platform').addEventListener('change', () => state.key && loadPlaylists().catch((error) => notice(error.message)));
$('#selectAll').addEventListener('click', () => { const boxes = [...playlistList.querySelectorAll('input')]; const shouldSelect = boxes.some((box) => !box.checked); boxes.forEach((box) => { box.checked = shouldSelect; }); syncButton(); });
$('#refreshHistory').addEventListener('click', loadHistory);
loadHistory();
if (state.key) connect();
