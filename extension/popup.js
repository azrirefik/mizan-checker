var toggle = document.getElementById('toggle');
var scanBtn = document.getElementById('scanBtn');
var stats = document.getElementById('stats');
var countEl = document.getElementById('count');
var verseList = document.getElementById('verseList');

chrome.storage.local.get(['enabled'], function(r) {
  toggle.checked = r.enabled !== false;
});

toggle.addEventListener('change', function() {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'toggle', enabled: toggle.checked });
  });
});

scanBtn.addEventListener('click', function() {
  verseList.innerHTML = '';
  stats.style.display = 'none';
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'scan' });
  });
});

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.action === 'scanResult') {
    countEl.textContent = msg.count;
    stats.style.display = msg.count > 0 ? 'block' : 'none';
    verseList.innerHTML = '';
    if (msg.verses) {
      var seen = {};
      msg.verses.forEach(function(ref) {
        if (seen[ref]) return;
        seen[ref] = true;
        var div = document.createElement('div');
        div.className = 'verse-item';
        div.textContent = ref;
        verseList.appendChild(div);
      });
    }
  }
});
