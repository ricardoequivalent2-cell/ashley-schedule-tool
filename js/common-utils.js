// Ashley Schedule Tool - Common Utilities
(function (global) {
  'use strict';

  function isWeekendLabel(label) {
    return /[토일]\s*$/.test(String(label || '').trim());
  }

  global.isWeekendLabel = isWeekendLabel;
})(window);
