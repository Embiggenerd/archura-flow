const el = (id) => document.getElementById(id);

const LABELS = {
  idle: 'idle',
  starting: 'starting…',
  recording: 'recording',
  capturing: 'capturing…',
  error: 'error',
};

function render(state) {
  el('status').textContent = LABELS[state.status] || state.status;
  el('status').dataset.status = state.status;
  el('tab').textContent = state.tabTitle || state.tabUrl || '—';
  el('tab').title = state.tabUrl || '';
  el('output').textContent = state.output || '—';
  el('screens').textContent = state.screenCount ?? 0;
  el('last').textContent = state.lastResult || '—';

  const recording = state.status === 'recording' || state.status === 'capturing';
  el('capture').textContent = recording ? 'Capture now' : 'Start recording';
  el('capture').disabled = state.status === 'capturing' || state.status === 'starting';
  el('stop').disabled = !recording;
  el('viewer').disabled = !recording && !state.viewerUrl;
  el('retry').hidden = state.status !== 'error';

  el('error').hidden = !state.lastError;
  el('error').textContent = state.lastError || '';
}

async function call(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (response?.error) {
    el('error').hidden = false;
    el('error').textContent = response.error;
    return;
  }
  if (response?.state) render(response.state);
}

el('capture').addEventListener('click', () => call('capture'));
el('stop').addEventListener('click', () => call('stop'));
el('viewer').addEventListener('click', () => call('viewer'));
el('retry').addEventListener('click', () => call('retry'));

// The worker pushes state as captures land so an open popup stays current.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'state') render(message.state);
});

call('state');
