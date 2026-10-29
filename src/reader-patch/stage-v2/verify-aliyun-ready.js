'use strict';
require('./recovery-infrastructure').ensureReady().then(() => {
  console.log('Original bot account, authorized group and empty draft verified.');
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
