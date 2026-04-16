// /api/sign-contract.js
// Handles contract signing submissions — Stephens Advanced LLC

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const supabase = createClient(
    'https://motjasdokoxwiodwzyps.supabase.co',
    process.env.SUPABASE_SERVICE_KEY
  )

  const {
    contractId,
    customerInfo,
    businessHours,
    billingElection,
    signature,
    signerName,
    signerTitle,
    cardNonce,
    language
  } = req.body || {}

  // ── Validate required fields ──────────────────────────────────────
  if (!contractId) return res.status(400).json({ error: 'Missing contractId' })
  if (!signature) return res.status(400).json({ error: 'Missing signature' })
  if (!signerName) return res.status(400).json({ error: 'Missing signerName' })
  if (!billingElection) return res.status(400).json({ error: 'Missing billingElection' })
  if (!['auto_charge', 'billed_invoice'].includes(billingElection)) {
    return res.status(400).json({ error: 'Invalid billingElection — must be auto_charge or billed_invoice' })
  }

  try {
    // ── 1. Load contract & verify it exists and isn't already signed ──
    const { data: contract, error: fetchErr } = await supabase
      .from('contracts')
      .select('*, location_id, billing_account_id')
      .eq('id', contractId)
      .single()

    if (fetchErr || !contract) {
      console.error('Contract lookup error:', fetchErr)
      return res.status(400).json({ error: 'Contract not found' })
    }

    if (contract.signed) {
      return res.status(409).json({ error: 'Contract has already been signed' })
    }

    // ── 2. Square — save card on file (if nonce provided) ───────────
    let squareCustomerId = null
    let cardLast4 = null
    let cardBrand = null

    if (cardNonce) {
      const accessToken = process.env.SQUARE_ACCESS_TOKEN
      const baseUrl = process.env.SQUARE_BASE_URL || 'https://connect.squareup.com'
      const sqHeaders = {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }

      // Create Square customer
      const custName = customerInfo?.contactName || signerName || ''
      const custRes = await fetch(`${baseUrl}/v2/customers`, {
        method: 'POST',
        headers: sqHeaders,
        body: JSON.stringify({
          idempotency_key: `contract-cust-${contractId}`,
          given_name: custName.split(' ')[0] || '',
          family_name: custName.split(' ').slice(1).join(' ') || '',
          email_address: customerInfo?.email || undefined,
          phone_number: customerInfo?.phone
            ? customerInfo.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '+1$1')
            : undefined,
          company_name: customerInfo?.legalName || undefined,
          reference_id: contract.location_id || contractId
        })
      })
      const custData = await custRes.json()
      if (!custRes.ok) {
        console.error('Square CreateCustomer error:', custData)
        return res.status(500).json({ error: 'Failed to create Square customer', detail: custData.errors?.[0]?.detail })
      }
      squareCustomerId = custData.customer.id

      // Save card with nonce
      const crypto = require('crypto')
      const cardRes = await fetch(`${baseUrl}/v2/cards`, {
        method: 'POST',
        headers: sqHeaders,
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          source_id: cardNonce,
          card: {
            customer_id: squareCustomerId
          }
        })
      })
      const cardData = await cardRes.json()
      if (!cardRes.ok) {
        console.error('Square CreateCard error:', cardData)
        return res.status(500).json({ error: 'Failed to save card', detail: cardData.errors?.[0]?.detail })
      }
      cardLast4 = cardData.card.last_4
      cardBrand = cardData.card.card_brand
    }

    const now = new Date().toISOString()

    // ── 3. Update contract ──────────────────────────────────────────
    const { error: contractUpdateErr } = await supabase
      .from('contracts')
      .update({
        signed: true,
        signed_at: now,
        signature_data: signature,
        status: 'active',
        language: language || 'en',
        signer_name: signerName,
        signer_title: signerTitle || null,
        signer_info: {
          name: signerName,
          title: signerTitle || null,
          signed_at: now,
          billing_election: billingElection,
          customer_info: customerInfo || {}
        }
      })
      .eq('id', contractId)

    if (contractUpdateErr) {
      console.error('Contract update error:', contractUpdateErr)
      return res.status(500).json({ error: 'Failed to update contract' })
    }

    // ── 4. Update location ──────────────────────────────────────────
    if (contract.location_id) {
      const locationUpdate = {}
      if (businessHours) locationUpdate.business_hours = businessHours
      if (customerInfo?.preferredServiceTime) locationUpdate.preferred_service_time = customerInfo.preferredServiceTime
      if (customerInfo?.contactName) locationUpdate.contact_name = customerInfo.contactName
      if (customerInfo?.phone) locationUpdate.contact_phone = customerInfo.phone
      if (customerInfo?.email) locationUpdate.contact_email = customerInfo.email
      if (customerInfo?.serviceAddress) locationUpdate.address = customerInfo.serviceAddress
      if (customerInfo?.secondaryContact) locationUpdate.secondary_contact = customerInfo.secondaryContact
      if (customerInfo?.secondaryPhone) locationUpdate.secondary_phone = customerInfo.secondaryPhone

      if (Object.keys(locationUpdate).length) {
        const { error: locErr } = await supabase
          .from('locations')
          .update(locationUpdate)
          .eq('id', contract.location_id)
        if (locErr) console.error('Location update error:', locErr)
      }
    }

    // ── 5. Update billing account ───────────────────────────────────
    if (contract.billing_account_id) {
      const billingUpdate = { billing_election: billingElection }
      if (squareCustomerId) {
        billingUpdate.card_on_file = true
        billingUpdate.square_customer_id = squareCustomerId
        billingUpdate.card_last4 = cardLast4
        billingUpdate.card_brand = cardBrand
      }
      if (customerInfo?.billingAddress) billingUpdate.billing_address = customerInfo.billingAddress
      if (customerInfo?.legalName) billingUpdate.legal_name = customerInfo.legalName
      if (customerInfo?.dba) billingUpdate.dba = customerInfo.dba

      const { error: billErr } = await supabase
        .from('billing_accounts')
        .update(billingUpdate)
        .eq('id', contract.billing_account_id)
      if (billErr) console.error('Billing account update error:', billErr)
    }

    // ── 6. Audit log ────────────────────────────────────────────────
    try {
      await supabase.from('audit_log').insert({
        action: 'signed',
        entity_type: 'contract',
        entity_id: contractId,
        actor: signerName,
        summary: `Contract signed by ${signerName}${signerTitle ? ' (' + signerTitle + ')' : ''} — ${billingElection}${cardLast4 ? ', card ****' + cardLast4 : ''}`
      })
    } catch (e) {}

    return res.status(200).json({
      success: true,
      contractId,
      signed_at: now
    })

  } catch (err) {
    console.error('sign-contract error:', err)
    return res.status(500).json({ error: err.message })
  }
}
