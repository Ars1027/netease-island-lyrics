'use strict';

// Deliberately no registry fallback: the upstream binary truncates artwork.
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This local SMTC build supports Windows x64 only');
}
module.exports = require('./windows-smtc-monitor.win32-x64-msvc.node');
