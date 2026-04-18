// /api/riker-actions.js
// Compat shim — the original action-parsing system was replaced by the
// tool-use architecture in api/riker-tools.js. This file exists so that
// older call sites (sms-inbound.js, email-inbound.js, riker-proactive.js)
// which still import sendSMS / sendEmail / JON_PHONE from here continue
// to work without changes. New code should require('./riker-tools') and
// use sendSMSRaw / sendEmailRaw.

const tools = require('./riker-tools')

module.exports = {
  JON_PHONE: tools.JON_PHONE,
  sendSMS: tools.sendSMSRaw,
  sendEmail: tools.sendEmailRaw
}
