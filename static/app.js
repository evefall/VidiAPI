/* ViDi Client Control Panel — Frontend Logic */

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
const api = {
    async get(path) {
        const resp = await fetch(path);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
        }
        return resp.json();
    },
    async post(path, body) {
        const resp = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
        }
        return resp.json();
    },
    async put(path, body) {
        const resp = await fetch(path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
        }
        return resp.json();
    },
    async postForm(path, formData) {
        const resp = await fetch(path, { method: 'POST', body: formData });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
        }
        return resp.json();
    },
    async delete(path) {
        const resp = await fetch(path, { method: 'DELETE' });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
        }
        return resp.json();
    },
};

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
function showToast(message, type = 'info') {
    const container = document.getElementById('toasts');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.onclick = () => toast.remove();
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
            if (tab.dataset.tab === 'workspaces') loadWorkspaces();
            if (tab.dataset.tab === 'import') loadWorkspaces();
            if (tab.dataset.tab === 'training') loadWorkspaces();
            if (tab.dataset.tab === 'jobs') loadJobs();
        });
    });
}

// ---------------------------------------------------------------------------
// Connection tab
// ---------------------------------------------------------------------------
async function loadSettings() {
    try {
        const s = await api.get('/api/settings');
        document.getElementById('cfg-host').value = s.vidi_server_host;
        document.getElementById('cfg-port').value = s.vidi_server_port;
        document.getElementById('cfg-share').value = s.upload_share_path;
    } catch (e) {
        showToast('Failed to load settings: ' + e.message, 'error');
    }
}

async function saveSettings() {
    try {
        const s = await api.put('/api/settings', {
            vidi_server_host: document.getElementById('cfg-host').value,
            vidi_server_port: parseInt(document.getElementById('cfg-port').value),
            upload_share_path: document.getElementById('cfg-share').value,
        });
        showToast('Settings saved', 'success');
    } catch (e) {
        showToast('Failed to save: ' + e.message, 'error');
    }
}

async function testConnection() {
    const btn = document.getElementById('btn-test');
    const result = document.getElementById('conn-result');
    btn.disabled = true;
    btn.textContent = 'Testing...';
    try {
        const r = await api.get('/api/settings/test-connection');
        const statusEl = document.getElementById('header-status');
        if (r.connected) {
            result.innerHTML = `<span style="color:#16a34a">Connected</span> — latency ${r.latency_ms}ms, ViDi initialized: ${r.vidi_initialized}`;
            statusEl.textContent = `Connected to ${document.getElementById('cfg-host').value}`;
            statusEl.className = 'status connected';
            loadGpuInfo();
        } else {
            result.innerHTML = `<span style="color:#dc2626">Failed</span> — ${r.error}`;
            statusEl.textContent = 'Disconnected';
            statusEl.className = 'status disconnected';
        }
    } catch (e) {
        result.innerHTML = `<span style="color:#dc2626">Error</span> — ${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = 'Test Connection';
}

async function loadGpuInfo() {
    try {
        const r = await api.get('/api/gpu');
        const el = document.getElementById('gpu-info');
        if (r.devices_xml) {
            const parser = new DOMParser();
            const xml = parser.parseFromString(r.devices_xml, 'text/xml');
            const devices = xml.querySelectorAll('device');
            if (devices.length > 0) {
                let html = '';
                devices.forEach((d) => {
                    const idx = d.getAttribute('index') || '?';
                    const name = d.getAttribute('id') || 'Unknown';
                    const memBytes = parseInt(d.getAttribute('memory') || '0');
                    const memMB = Math.round(memBytes / (1024 * 1024));
                    const freeBytes = parseInt(d.getAttribute('free_memory') || '0');
                    const freeMB = Math.round(freeBytes / (1024 * 1024));
                    const ver = d.getAttribute('version') || '';
                    html += `GPU ${idx}: ${name}\n  VRAM: ${memMB} MB (${freeMB} MB free) | Compute: ${ver}\n`;
                });
                el.textContent = html.trim();
            } else {
                el.textContent = r.devices_xml;
            }
        } else {
            el.textContent = 'No GPU info available';
        }
    } catch (e) {
        document.getElementById('gpu-info').textContent = 'Failed to load GPU info';
    }
}

// ---------------------------------------------------------------------------
// Workspaces tab
// ---------------------------------------------------------------------------

// Store workspace data globally so onclick handlers can look up paths safely
// (avoids backslash escaping issues in inline HTML onclick attributes)
const _wsPathMap = {};

async function loadWorkspaces() {
    try {
        const allWs = await api.get('/api/workspaces');
        const tbody = document.getElementById('ws-tbody');
        if (allWs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">No workspaces found</td></tr>';
            return;
        }

        // Cache paths by name
        allWs.forEach(w => { _wsPathMap[w.name] = w.path; });

        // Separate open and available
        const open = allWs.filter(w => w.status === 'open');

        tbody.innerHTML = allWs.map(w => {
            const statusBadge = w.status === 'open'
                ? '<span style="padding:2px 6px;background:#c8e6c9;color:#2e7d32;border-radius:3px;font-size:12px;font-weight:600">OPEN</span>'
                : '<span style="padding:2px 6px;background:#e0e0e0;color:#666;border-radius:3px;font-size:12px">available</span>';

            // Pass only the name — path is looked up from _wsPathMap to avoid
            // backslash escaping issues with Windows paths in onclick strings
            const toggleBtn = w.status === 'open'
                ? `<button class="btn btn-secondary btn-sm" onclick="closeWorkspace('${w.name}')">Close</button>`
                : `<button class="btn btn-success btn-sm" onclick="openWorkspaceDialog('${w.name}')">Open</button>`;
            const actionBtn = toggleBtn +
                ` <button class="btn btn-danger btn-sm" onclick="deleteWorkspace('${w.name}')" title="Radera permanent">Delete</button>`;

            return `<tr>
                <td><strong>${w.name}</strong></td>
                <td style="font-size:12px;color:#64748b">${w.path}</td>
                <td>${statusBadge}</td>
                <td>${actionBtn}</td>
            </tr>`;
        }).join('');

        // Also update workspace selectors (only open ones)
        updateWorkspaceSelectors(open);
    } catch (e) {
        showToast('Failed to load workspaces: ' + e.message, 'error');
    }
}

async function openWorkspaceDialog(name) {
    const path = _wsPathMap[name];
    if (!path) { showToast(`No path found for workspace "${name}"`, 'error'); return; }
    try {
        await api.post(`/api/workspaces/${name}/open`, { path });
        showToast(`Workspace "${name}" opened`, 'success');
        loadWorkspaces();
    } catch (e) {
        showToast('Failed to open workspace: ' + e.message, 'error');
    }
}

function updateWorkspaceSelectors(workspaces) {
    const selectors = document.querySelectorAll('.ws-selector');
    selectors.forEach(sel => {
        const current = sel.value;
        sel.innerHTML = '<option value="">-- Select workspace --</option>';
        workspaces.forEach(w => {
            sel.innerHTML += `<option value="${w.name}">${w.name}</option>`;
        });
        if (current) sel.value = current;
    });
}

async function createWorkspace() {
    const name = document.getElementById('ws-name').value.trim();
    const toolType = document.getElementById('ws-tool-type').value;
    const toolName = document.getElementById('ws-tool-name').value.trim() || 'Analyze';
    if (!name) { showToast('Workspace name is required', 'error'); return; }
    try {
        await api.post('/api/workspaces', { name, tool_name: toolName, tool_type: toolType });
        showToast(`Workspace "${name}" created`, 'success');
        document.getElementById('ws-name').value = '';
        loadWorkspaces();
    } catch (e) {
        showToast('Failed to create workspace: ' + e.message, 'error');
    }
}

async function closeWorkspace(name) {
    try {
        await api.post(`/api/workspaces/${name}/close`);
        showToast(`Workspace "${name}" closed`, 'success');
        loadWorkspaces();
    } catch (e) {
        showToast('Failed to close workspace: ' + e.message, 'error');
    }
}

async function deleteWorkspace(name) {
    if (!confirm(`Ta bort workspace "${name}"?\n\nDetta raderar alla filer permanent och kan inte ångras.`)) return;
    try {
        await api.delete(`/api/workspaces/${name}`);
        showToast(`Workspace "${name}" raderat`, 'success');
        delete _wsPathMap[name];
        loadWorkspaces();
    } catch (e) {
        showToast('Kunde inte radera workspace: ' + e.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Import tab
// ---------------------------------------------------------------------------
function isGoodImport() {
    return document.querySelector('input[name="import-class"]:checked').value === 'good';
}

function toggleImportClass() {
    const good = isGoodImport();
    document.getElementById('import-bad-options').style.display = good ? 'none' : 'block';
    document.getElementById('import-lbl-dir-group').style.display = good ? 'none' : 'block';
    document.getElementById('upload-labels-group').style.display = good ? 'none' : 'block';
    document.getElementById('import-img-dir').placeholder = good
        ? 'Z:\\\\Images\\\\train\\\\good'
        : 'Z:\\\\Images\\\\train\\\\bad';
}

function toggleImportMode() {
    const mode = document.querySelector('input[name="import-mode"]:checked').value;
    document.getElementById('import-server-paths').style.display = mode === 'server' ? 'block' : 'none';
    document.getElementById('import-local-upload').style.display = mode === 'upload' ? 'block' : 'none';
}

async function startImportServer() {
    const workspace = document.getElementById('import-ws').value;
    const imageDir = document.getElementById('import-img-dir').value.trim();
    const toolType = document.getElementById('import-tool-type').value;
    const good = isGoodImport();

    if (!workspace) { showToast('Select a workspace', 'error'); return; }
    if (!imageDir) { showToast('Image directory is required', 'error'); return; }

    const body = {
        workspace,
        image_dir: imageDir,
        tool_type: toolType,
    };

    if (good) {
        // Good import: use image_dir as label_dir — no matching .txt files = no annotations
        body.label_dir = imageDir;
    } else {
        const labelDir = document.getElementById('import-lbl-dir').value.trim();
        if (!labelDir) { showToast('Label directory is required for bad images', 'error'); return; }
        body.label_dir = labelDir;
        body.annotation_format = document.getElementById('import-format').value;
        body.defect_class_name = document.getElementById('import-defect-class').value.trim() || 'bad';
    }

    try {
        const r = await api.post('/api/import/from-directory', body);
        showToast(`Import started (${good ? 'good' : 'bad'}) — Job ID: ${r.id}`, 'success');
        document.querySelector('.tab[data-tab="jobs"]').click();
    } catch (e) {
        showToast('Import failed: ' + e.message, 'error');
    }
}

async function startImportUpload() {
    const workspace = document.getElementById('import-ws').value;
    const toolType = document.getElementById('import-tool-type').value;
    const good = isGoodImport();
    const imageFiles = document.getElementById('upload-images').files;

    if (!workspace) { showToast('Select a workspace', 'error'); return; }
    if (imageFiles.length === 0) { showToast('Select image files', 'error'); return; }

    const fd = new FormData();
    fd.append('workspace', workspace);
    fd.append('tool_type', toolType);
    for (const f of imageFiles) fd.append('images', f);

    if (!good) {
        const labelFiles = document.getElementById('upload-labels').files;
        if (labelFiles.length === 0) { showToast('Select label files for bad images', 'error'); return; }
        fd.append('annotation_format', document.getElementById('import-format').value);
        fd.append('defect_class_name', document.getElementById('import-defect-class').value.trim() || 'bad');
        for (const f of labelFiles) fd.append('labels', f);
    }

    try {
        showToast('Uploading files...', 'info');
        const r = await api.postForm('/api/import/upload', fd);
        showToast(`Import started (${good ? 'good' : 'bad'}) — Job ID: ${r.id}`, 'success');
        document.querySelector('.tab[data-tab="jobs"]').click();
    } catch (e) {
        showToast('Upload failed: ' + e.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Training tab
// ---------------------------------------------------------------------------
async function startTraining() {
    const workspace = document.getElementById('train-ws').value;
    const artifact = document.getElementById('train-artifact').value;
    if (!workspace) { showToast('Select a workspace', 'error'); return; }

    try {
        const r = await api.post('/api/training/start', { workspace, artifact });
        showToast(`Training started — Job ID: ${r.id}`, 'success');
        document.querySelector('.tab[data-tab="jobs"]').click();
    } catch (e) {
        showToast('Training failed: ' + e.message, 'error');
    }
}

async function exportModel() {
    const workspace = document.getElementById('export-ws').value;
    const outputPath = document.getElementById('export-path').value.trim();
    if (!workspace) { showToast('Select a workspace', 'error'); return; }
    if (!outputPath) { showToast('Output path is required', 'error'); return; }

    try {
        const r = await api.post('/api/training/export', { workspace, output_path: outputPath });
        showToast(`Export complete: ${r.path}`, 'success');
    } catch (e) {
        showToast('Export failed: ' + e.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Jobs tab
// ---------------------------------------------------------------------------
let jobPollTimer = null;

async function loadJobs() {
    try {
        const jobs = await api.get('/api/jobs');
        renderJobsTable(jobs);
        const hasActive = jobs.some(j => j.status === 'running' || j.status === 'queued');
        startJobPolling(hasActive ? 2000 : 8000);
    } catch (e) {
        // Silently retry on poll failure
    }
}

function startJobPolling(interval) {
    if (jobPollTimer) clearInterval(jobPollTimer);
    jobPollTimer = setInterval(loadJobs, interval);
}

function renderJobsTable(jobs) {
    const tbody = document.getElementById('jobs-tbody');
    if (jobs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No jobs</td></tr>';
        return;
    }
    // Sort: running first, then queued, then by created_at desc
    jobs.sort((a, b) => {
        const order = { running: 0, queued: 1, completed: 2, failed: 3, cancelled: 4 };
        const diff = (order[a.status] ?? 5) - (order[b.status] ?? 5);
        if (diff !== 0) return diff;
        return new Date(b.created_at) - new Date(a.created_at);
    });

    tbody.innerHTML = jobs.map(j => {
        const pct = Math.round(j.progress * 100);
        const badge = `<span class="badge badge-${j.status}">${j.status}</span>`;
        const time = new Date(j.created_at).toLocaleTimeString();
        const msg = j.error || j.message || '';
        const cancelBtn = (j.status === 'running' && j.type === 'training')
            ? `<button class="btn btn-danger btn-sm" onclick="cancelJob('${j.id}')">Cancel</button>`
            : '';
        return `<tr>
            <td><code>${j.id}</code></td>
            <td>${j.type}</td>
            <td>${badge}</td>
            <td><div class="progress-bar"><div class="progress-fill" style="width:${pct}%">${pct}%</div></div></td>
            <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${msg}">${msg}</td>
            <td style="font-size:12px;color:#64748b">${time} ${cancelBtn}</td>
        </tr>`;
    }).join('');
}

async function cancelJob(jobId) {
    try {
        await api.post(`/api/training/${jobId}/cancel`);
        showToast(`Job ${jobId} cancelled`, 'success');
        loadJobs();
    } catch (e) {
        showToast('Cancel failed: ' + e.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Image Viewer
// ---------------------------------------------------------------------------
async function loadImageAnnotations() {
    const ws = document.getElementById('viewer-ws').value;
    if (!ws) {
        document.getElementById('viewer-tbody').innerHTML = '<tr><td colspan="4" class="empty">Select workspace</td></tr>';
        document.getElementById('viewer-stats').style.display = 'none';
        return;
    }

    try {
        const data = await api.get(`/api/v1/viewer/images?workspace=${encodeURIComponent(ws)}`);
        const stats = await api.get(`/api/v1/viewer/image-stats?workspace=${encodeURIComponent(ws)}`);

        // Update stats
        document.getElementById('stat-total').textContent = stats.total_images;
        document.getElementById('stat-good').textContent = stats.good_images;
        document.getElementById('stat-bad').textContent = stats.bad_images;
        document.getElementById('stat-annot').textContent = stats.total_annotations;
        document.getElementById('viewer-stats').style.display = 'block';

        // Render images table
        const tbody = document.getElementById('viewer-tbody');
        if (data.images.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">No images in workspace</td></tr>';
            return;
        }

        tbody.innerHTML = data.images.map(img => {
            const badgeBg = img.class === 'good' ? '#c8e6c9' : '#ffcdd2';
            const badgeColor = img.class === 'good' ? '#2e7d32' : '#c62828';
            const classLabel = img.class.toUpperCase();

            return `<tr>
                <td><code style="font-size:11px">${img.name}</code></td>
                <td><span style="padding:4px 8px;background:${badgeBg};color:${badgeColor};border-radius:4px;font-weight:600;font-size:12px">${classLabel}</span></td>
                <td>${img.width}×${img.height}</td>
                <td style="font-size:12px;color:#666">${img.annotation_summary}</td>
            </tr>`;
        }).join('');

    } catch (e) {
        showToast('Failed to load images: ' + e.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// File Browser
// ---------------------------------------------------------------------------
let browserTarget = null;  // 'img' or 'lbl'
let browserCurrentPath = null;

async function openBrowser(target) {
    browserTarget = target;
    browserCurrentPath = target === 'img' ? document.getElementById('import-img-dir').value : document.getElementById('import-lbl-dir').value;
    if (!browserCurrentPath) browserCurrentPath = 'C:\\';

    document.getElementById('browser-modal').style.display = 'flex';
    await loadDrives();
    await loadBrowserPath(browserCurrentPath);
}

function closeBrowser() {
    document.getElementById('browser-modal').style.display = 'none';
    browserTarget = null;
}

async function loadDrives() {
    try {
        const drives = await api.get('/api/v1/browse/drives');
        const drivesDiv = document.getElementById('browser-drives');
        drivesDiv.innerHTML = drives.map(d =>
            `<button class="drive-btn" onclick="loadBrowserPath('${d}\\\\')"><strong>${d}</strong></button>`
        ).join('');
    } catch (e) {
        showToast('Failed to load drives: ' + e.message, 'error');
    }
}

async function loadBrowserPath(path) {
    try {
        browserCurrentPath = path;
        const data = await api.get(`/api/v1/browse/path?dir_path=${encodeURIComponent(path)}`);

        document.getElementById('browser-path').textContent = data.current_path;

        let html = '';
        if (data.parent_path) {
            html += `<div class="browser-item folder" onclick="loadBrowserPath('${data.parent_path}')">📁 .. (parent)</div>`;
        }

        for (const item of data.items) {
            if (item.is_dir) {
                html += `<div class="browser-item folder" onclick="loadBrowserPath('${item.path}')">${item.name}</div>`;
            }
        }

        document.getElementById('browser-list').innerHTML = html || '<div style="padding:8px;color:#999">Empty folder</div>';

        // Load image count
        await loadImageCount(path);

    } catch (e) {
        showToast('Browse failed: ' + e.message, 'error');
    }
}

async function loadImageCount(path) {
    try {
        const data = await api.get(`/api/v1/browse/images?dir_path=${encodeURIComponent(path)}`);
        const countDiv = document.getElementById('browser-image-count');
        const countText = document.getElementById('browser-count-text');

        if (data.total > 0) {
            const exts = Object.entries(data.by_extension)
                .map(([ext, count]) => `${count}×${ext}`)
                .join(', ');
            countText.textContent = `✅ Found ${data.total} images: ${exts}`;
            countDiv.style.display = 'block';
            document.getElementById('browser-select-btn').style.display = 'block';
        } else {
            countDiv.style.display = 'none';
            document.getElementById('browser-select-btn').style.display = 'none';
        }
    } catch (e) {
        // Silently ignore count errors
    }
}

function selectBrowserPath() {
    if (browserTarget === 'img') {
        document.getElementById('import-img-dir').value = browserCurrentPath;
    } else if (browserTarget === 'lbl') {
        document.getElementById('import-lbl-dir').value = browserCurrentPath;
    }
    closeBrowser();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    loadSettings();
    testConnection();
});
