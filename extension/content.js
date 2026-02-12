(function() {
  'use strict';

  var highlights = [];
  var enabled = true;

  chrome.storage.local.get(['enabled'], function(r) {
    enabled = r.enabled !== false;
    if (enabled) init();
  });

  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg.action === 'toggle') {
      enabled = msg.enabled;
      chrome.storage.local.set({ enabled: enabled });
      if (enabled) scanPage();
      else clearHighlights();
    } else if (msg.action === 'scan') {
      clearHighlights();
      scanPage();
    }
  });

  function init() {
    QuranChecker.loadData(function() {
      scanPage();
      // Watch for DOM changes (lazy-loaded content)
      var observer = new MutationObserver(function(mutations) {
        var hasNewText = mutations.some(function(m) {
          return m.type === 'childList' && m.addedNodes.length > 0;
        });
        if (hasNewText) debounceScan();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  var scanTimeout = null;
  function debounceScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(function() { clearHighlights(); scanPage(); }, 500);
  }

  function clearHighlights() {
    highlights.forEach(function(h) {
      if (h.parentNode && !h.__removed) {
        h.__removed = true;
        h.replaceWith(document.createTextNode(h.textContent));
      }
    });
    highlights = [];
  }

  function scanPage() {
    if (!enabled || !QuranChecker.ready()) return;

    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          // Skip script/style tags and already-highlighted nodes
          var p = node.parentElement;
          if (!p || p.closest('script,style,noscript,textarea,input,code,pre,[data-qc]')) return NodeFilter.FILTER_REJECT;
          if (p.closest('.qc-highlight')) return NodeFilter.FILTER_REJECT;
          // Skip nodes inside our own highlights
          if (/[\u0600-\u06FF]{4,}/.test(node.textContent)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_REJECT;
        }
      }
    );

    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);

    nodes.forEach(function(node) {
      processTextNode(node);
    });

    // Notify popup
    chrome.runtime.sendMessage({
      action: 'scanResult',
      count: highlights.length,
      verses: highlights.map(function(h) { return h.__verseRef; })
    });
  }

  function processTextNode(node) {
    var text = node.textContent;
    // Extract Arabic segments (words + spaces, 4+ Arabic chars)
    var pattern = /[\u0600-\u06FF][\u0600-\u06FF\s]{3,}/g;
    var segments = [];
    var m;
    while ((m = pattern.exec(text)) !== null) {
      segments.push({ text: m[0].trim(), start: m.index, end: m.index + m[0].length });
    }

    if (segments.length === 0) return;

    // Validate each segment
    var results = segments.map(function(seg) {
      return { segment: seg, validation: QuranChecker.validate(seg.text) };
    }).filter(function(r) { return r.validation !== null; });

    if (results.length === 0) return;

    // Replace text node with highlighted spans
    var parent = node.parentNode;
    var container = document.createDocumentFragment();
    var lastIdx = 0;

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var seg = r.segment;
      var v = r.validation;

      // Text before this segment
      if (seg.start > lastIdx) {
        container.appendChild(document.createTextNode(text.slice(lastIdx, seg.start)));
      }

      // Highlighted span
      var span = document.createElement('span');
      span.className = 'qc-highlight qc-' + v.matchType;
      span.textContent = text.slice(seg.start, seg.end);
      span.title = v.reference;
      span.setAttribute('data-qc', v.reference);
      span.__verseRef = v.reference;
      highlights.push(span);
      container.appendChild(span);

      lastIdx = seg.end;
    }

    // Remaining text after last segment
    if (lastIdx < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIdx)));
    }

    parent.replaceChild(container, node);
  }
})();
