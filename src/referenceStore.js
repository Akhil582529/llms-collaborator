'use strict';
let current = null;
module.exports = {
  set: (spec) => { current = spec; },
  get: () => current,
  clear: () => { current = null; },
};