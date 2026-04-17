// /src/config/mazon.js
// Single source of truth for Mazon Associates, Inc. identity.
// Every file that references Mazon imports from here. Do not hardcode these
// strings anywhere else in the codebase.

module.exports = {
  LEGAL_NAME: 'Mazon Associates, Inc.',
  REMIT_ADDRESS_LINE_1: 'P.O. Box 166858',
  REMIT_ADDRESS_LINE_2: 'Irving, TX 75016-6858',
  REMIT_ADDRESS_FULL: 'P.O. Box 166858, Irving, TX 75016-6858',
  PHONE: '(972) 554-6967',
  SUBMISSION_EMAIL: 'schedule@mazon.com',
  CLIENT_NUMBER: '1410',
  // PIN is read from env var at runtime; never commit a value here
  PIN_ENV_VAR: 'MAZON_PIN',
  get PIN() {
    return process.env[this.PIN_ENV_VAR] || null
  },
  SAME_DAY_CUTOFF_LOCAL: '10:00',           // 10:00 AM Central
  TIMEZONE: 'America/Chicago',
  SUBMISSION_DAY: 5,                         // Friday (0=Sun ... 5=Fri)
  BATCH_THRESHOLD_USD: 1000.00,

  // Storage buckets
  BUCKETS: {
    SIGNATURES: 'signatures',
    INVOICES: 'mazon-invoices',
    BACKUPS: 'mazon-backups',
    SCHEDULES: 'mazon-schedules',
    TEMPLATES: 'mazon-templates'
  },

  TEMPLATE_PATH: 'schedule_of_accounts_template.xlsx',

  // Customer-facing assignment language shown above the signature pad
  ASSIGNMENT_LANGUAGE: `By signing below, I authorize Stephens Advanced LLC to assign this invoice to Mazon Associates, Inc. for factoring. I agree to remit payment for this invoice directly to Mazon Associates, Inc. at the address shown on the invoice. I acknowledge that Stephens Advanced LLC has performed the services described in this invoice to my satisfaction.`,

  // Invoice stamp text — burned into the PDF
  STAMP_NOTICE_TITLE: 'NOTICE OF ASSIGNMENT',
  STAMP_NOTICE_BODY: [
    'This invoice has been assigned to and is payable only to:',
    'Mazon Associates, Inc.',
    'P.O. Box 166858, Irving, TX 75016-6858',
    'Payment to any other party will not satisfy the obligation under this invoice.',
    'For questions call: (972) 554-6967'
  ],

  STAMP_REMIT_TITLE: 'REMIT PAYMENT TO:',
  STAMP_REMIT_BODY: [
    'Mazon Associates, Inc.',
    'P.O. Box 166858, Irving, TX 75016-6858'
  ]
}
