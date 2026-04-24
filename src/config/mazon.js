// /src/config/mazon.js
// Single source of truth for Mazon Associates, Inc. identity.
// Every file that references Mazon imports from here. Do not hardcode these
// strings anywhere else in the codebase.

module.exports = {
  LEGAL_NAME: 'Mazon Associates, Inc.',
  REMIT_ADDRESS_LINE_1: 'P.O. Box 166858',
  REMIT_ADDRESS_LINE_2: 'Irving, TX 75016-6858',
  REMIT_ADDRESS_FULL: 'P.O. Box 166858, Irving, TX 75016-6858',
  PHONE: '972-554-6967',
  FAX: '972-554-0951',
  SUBMISSION_EMAIL: 'schedule@mazon.com',
  CLIENT_NUMBER: '1410',

  // Wire / ACH payment info (from official Mazon payment stamp)
  BANK_NAME: 'Frost Bank',
  BANK_ABA: '114000093',
  BANK_ACCOUNT: '980003506',
  BANK_BENEFICIARY: 'Mazon Associates, Inc.',
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

  // Invoice stamp text — burned into the PDF.
  // Exact verbiage required by Mazon (see "Mazon Verbiage Stamp 1/2.pdf").
  STAMP_NOTICE_TITLE: 'PLEASE NOTE',
  STAMP_NOTICE_BODY: 'The right to payment under this invoice has been sold and assigned to Mazon Associates, Inc., and all payments hereunder are to be directed to the assignee at the address noted below. Remittance to other than Mazon does not constitute payment of this invoice. Mazon must be given notification of any claims, agreements or merchandise returns which would affect the payment of all or part of this invoice on the due date.',

  STAMP_MAIL_TITLE: 'If payment by regular mail:',
  STAMP_MAIL_BODY: [
    'Mazon Associates, Inc.',
    'P.O. Box 166858',
    'Irving, TX 75016-6858',
    '972-554-6967, Fax 972-554-0951'
  ],

  STAMP_WIRE_TITLE: 'If payment by electronic transfer:',
  STAMP_WIRE_BODY: [
    'Bank: Frost Bank',
    'ABA No: 114000093',
    'Beneficiary: Mazon Associates, Inc.',
    'Account No: 980003506'
  ],

  // Remit-address stamp (goes over Stephens' mailing address in header)
  STAMP_REMIT_TITLE: 'PLEASE REMIT PAYMENT TO:',
  STAMP_REMIT_BODY: [
    'Mazon Associates, Inc.',
    'P.O. Box 166858',
    'Irving, TX 75016-6858'
  ]
}
