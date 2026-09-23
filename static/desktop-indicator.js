// Computer-use control frame. Text only ever goes through textContent: the
// agent name and last action come from an agent, so they are never markup.
(function () {
  function apply(data) {
    if (!data || typeof data !== 'object') return;
    var who = document.getElementById('who');
    var action = document.getElementById('action');
    var stop = document.getElementById('stop');
    if (who) who.textContent = (data.agent || 'An agent') + ' is controlling this window';
    if (action) action.textContent = data.lastAction ? '— ' + data.lastAction : '';
    if (stop && data.stopShortcut) stop.textContent = data.stopShortcut;
  }
  window.__spacronIndicator = apply;
  try {
    if (location.hash.length > 1) apply(JSON.parse(decodeURIComponent(location.hash.slice(1))));
  } catch (e) {
    // A bad fragment leaves the generic text; the next update replaces it.
  }
})();
