#!/usr/bin/env node
'use strict';
// Compatibility entry: all starts share the v3.3 whitelist, cursor and singleton lock.
require('./bridge-v3.3').main().catch(e=>{console.error(e.message);process.exitCode=1;});
