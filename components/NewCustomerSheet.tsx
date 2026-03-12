'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function NewCustomerSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('TX')
  const [zip, setZip] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [billingDifferent, setBillingDifferent] = useState(false)
  const [billingName, setBillingName] = useState('')
  const [billingAddress, setBillingAddress] = useState('')
  const [billingEmail, setBillingEmail] = useState('')
  const [saving, setSaving] = useState(false)

  async function createCustomer() {
    if (!name || !address || !city || saving) return
    setSaving(true)

    try {
      let billingAccountId = null

      // Create billing account if different
      if (billingDifferent && billingName) {
        const { data: ba, error: baError } = await supabase
          .from('billing_accounts')
          .insert({
            name: billingName,
            address: billingAddress,
            email: billingEmail,
          })
          .select()
          .single()

        if (baError) throw baError
        billingAccountId = ba.id
      }

      // Create location
      const { error: locError } = await supabase
        .from('locations')
        .insert({
          name,
          address,
          city,
          state,
          zip,
          contact_name: contactName,
          contact_phone: contactPhone,
          contact_email: contactEmail,
          billing_account_id: billingAccountId,
        })

      if (locError) throw locError

      onCreated()
    } catch (err) {
      console.error('Create customer error:', err)
      alert('Error creating customer')
    }

    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-[200] bg-[#0a0c10] overflow-y-auto">
      <div className="sticky top-0 z-10 bg-[#0a0c10] px-4 py-3 flex items-center gap-3 border-b border-[#2a3040]">
        <button onClick={onClose} className="text-2xl text-gray-300 p-1">←</button>
        <div className="text-[17px] font-bold">New Customer</div>
      </div>

      <div className="px-4 pt-4 pb-32">
        {/* Business Name */}
        <div className="mb-3">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Business Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Restaurant name, business name..."
            className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
          />
        </div>

        {/* Address */}
        <div className="mb-3">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Address</label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="Street address"
            className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
          />
        </div>

        <div className="grid grid-cols-4 gap-2 mb-3">
          <div className="col-span-2">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">City</label>
            <input
              type="text"
              value={city}
              onChange={e => setCity(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">State</label>
            <input
              type="text"
              value={state}
              onChange={e => setState(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Zip</label>
            <input
              type="text"
              value={zip}
              onChange={e => setZip(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
            />
          </div>
        </div>

        {/* Contact */}
        <div className="mb-3">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Contact Name</label>
          <input
            type="text"
            value={contactName}
            onChange={e => setContactName(e.target.value)}
            className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
          />
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Phone</label>
            <input
              type="tel"
              value={contactPhone}
              onChange={e => setContactPhone(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Email</label>
            <input
              type="email"
              value={contactEmail}
              onChange={e => setContactEmail(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
            />
          </div>
        </div>

        {/* Billing Toggle */}
        <div className="mb-3">
          <button
            onClick={() => setBillingDifferent(!billingDifferent)}
            className={`w-full py-3 rounded-lg text-sm font-semibold border transition-colors ${
              billingDifferent
                ? 'bg-[#e85d26]/10 text-[#e85d26] border-[#e85d26]'
                : 'bg-[#12151c] text-gray-500 border-[#2a3040]'
            }`}
          >
            {billingDifferent ? '✓ Bills to different entity' : 'Bills to a different entity?'}
          </button>
        </div>

        {billingDifferent && (
          <>
            <div className="mb-3">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Billing Company Name</label>
              <input
                type="text"
                value={billingName}
                onChange={e => setBillingName(e.target.value)}
                placeholder="Franchise group, management company..."
                className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
              />
            </div>
            <div className="mb-3">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Billing Address</label>
              <input
                type="text"
                value={billingAddress}
                onChange={e => setBillingAddress(e.target.value)}
                className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
              />
            </div>
            <div className="mb-3">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Billing Email</label>
              <input
                type="email"
                value={billingEmail}
                onChange={e => setBillingEmail(e.target.value)}
                className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
              />
            </div>
          </>
        )}

        <button
          onClick={createCustomer}
          disabled={!name || !address || !city || saving}
          className="w-full py-4 bg-[#e85d26] text-white rounded-xl text-base font-bold active:opacity-80 disabled:opacity-50 mt-4"
        >
          {saving ? 'Creating...' : 'Create Customer'}
        </button>
      </div>
    </div>
  )
}
