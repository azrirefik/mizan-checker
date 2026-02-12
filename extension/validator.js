(function() {
  'use strict';

  var verseMap = null;
  var versesData = null;
  var corpus = null;

  function normKey(text) {
    var s = text.normalize('NFKD');
    s = s.replace(/[\u200c\u200d\u200e\u200f\u061c]/g, '');
    s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
    s = s.replace(/[أإآٱ]/g, 'ا');
    s = s.replace(/ى/g, 'ي');
    s = s.replace(/ة/g, 'ه');
    s = s.replace(/ؤ/g, 'و');
    s = s.replace(/ئ/g, 'ي');
    s = s.replace(/[\u0640\u06E5\u06E6]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function exactKey(text) {
    var s = text.normalize('NFKD');
    s = s.replace(/[\u200c\u200d\u200e\u200f\u061c]/g, '');
    s = s.replace(/\u0671/g, '\u0627');
    s = s.replace(/\u0670/g, '');
    s = s.replace(/[\u0640\u06E5\u06E6]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function loadData(callback) {
    if (verseMap) return callback();
    var url = chrome.runtime.getURL('quran-verses.min.json');
    fetch(url).then(function(r) { return r.json(); }).then(function(data) {
      versesData = data;
      verseMap = new Map();
      var corpusParts = [];

      for (var j = 0; j < data.length; j++) {
        var v = data[j];
        var key = normKey(v.text);
        addKey(v, key, corpusParts);
      }

      // Pre-strip Basmala from verse 1 of each surah (except Al-Fatiha)
      var basmalaVerse = null;
      for (var i = 0; i < data.length; i++) {
        if (data[i].surah === 1 && data[i].ayah === 1) { basmalaVerse = data[i]; break; }
      }
      if (basmalaVerse) {
        var basmala = basmalaVerse.text;
        for (var k = 0; k < data.length; k++) {
          var verse = data[k];
          if (verse.ayah === 1 && verse.surah !== 1 && verse.text.startsWith(basmala)) {
            var stripped = verse.text.slice(basmala.length).trim();
            if (stripped) {
              verse.displayText = stripped;
              var sk = normKey(stripped);
              addKey(verse, sk, corpusParts);
            }
          }
        }
      }

      corpus = corpusParts.join(' ');
      callback();
    });
  }

  function addKey(verse, key, corpusParts) {
    var arr = verseMap.get(key) || [];
    arr.push(verse);
    verseMap.set(key, arr);
    if (arr.length === 1) corpusParts.push(key);
  }

  function validate(text) {
    var trimmed = text.trim();
    if (!trimmed || !/[\u0600-\u06FF]/.test(trimmed)) return null;

    var key = normKey(trimmed);
    var matches = verseMap.get(key);

    if (matches && matches.length > 0) {
      var v = matches[0];
      var displayText = v.displayText || v.text;
      var isExact = exactKey(trimmed) === exactKey(displayText);
      return {
        isValid: true,
        matchType: isExact ? 'exact' : 'normalized',
        reference: v.surah + ':' + v.ayah,
        matchedVerse: v,
        input: trimmed
      };
    }
    return null;
  }

  function analyzeFabrication(text) {
    var key = normKey(text);
    var words = key.split(/\s+/).filter(Boolean);
    var results = [];
    if (words.length === 0) return results;

    var i = 0;
    while (i < words.length) {
      var lo = 1, hi = words.length - i, best = 0;
      while (lo <= hi) {
        var mid = Math.floor((lo + hi) / 2);
        var candidate = words.slice(i, i + mid).join(' ');
        if (corpus.indexOf(candidate) !== -1) { best = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }
      if (best > 0) {
        for (var j = i; j < i + best; j++) results.push({ word: words[j], isFabricated: false });
        i += best;
      } else {
        results.push({ word: words[i], isFabricated: true });
        i++;
      }
    }
    return results;
  }

  window.QuranChecker = {
    loadData: loadData,
    validate: validate,
    analyzeFabrication: analyzeFabrication,
    normKey: normKey,
    exactKey: exactKey,
    ready: function() { return verseMap !== null; }
  };
})();
