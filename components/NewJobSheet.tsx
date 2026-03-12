'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

export default function NewJobSheet({
  customers,
  onClose,
  onCreated,
}: {
  customers: any[]
  onClose: () => void
  onCreated: () => void
}) {
  const [customerQuery, setCustomerQuery] = useState('')
  const [showResults, setShowResults] = useState(false)
  const [selectedLocation, setSelectedLocation] = useState<any>(null)
  const [creatingNew, setCreatingNew] = useState(false)

  const [newName, setNewName] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [newCity, setNewCity] = useState('')
  const [newState, setNewState] = useState('TX')
  const [newZip, setNewZip] = useState('')
  const [newContact, setNewContact] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newEmail, setNewEmail] = useState('')

  const [billingDifferent, setBillingDifferent] = useState(false)
  const [billingQuery, setBillingQuery] = useState('')
  const [showBillingResults, setShowBillingResults] = useState(false)
  const [selectedBilling, setSelectedBilling] = useState<any>(null)
  const [creatingNewBilling, setCreatingNewBilling] = useState(false)
  const [newBillingName, setNewBillingName] = useState('')
  const [newBillingContact, setNewBillingContact] = useState('')
  const [newBillingPhone, setNewBillingPhone] = useState('')
  const [newBillingEmail, setNewBillingEmail] = useState('')

  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [time, setTime] = useState('09:00')
  const [type, setType] = useState('inspection')
  const [scope, setScope] = useState<string[]>(['extinguishers', 'suppression'])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [billingAccounts, setBillingAccounts] = useState<any[]>([])

  useEffect(() => {
    supabase.from('billing_accounts').select('*').order('name').then(({ data }) => setBillingAccounts(data || []))
  }, [])

  const filteredCustomers = customerQuery.length >= 1
    ? customers.filter(c =>
        c.name.toLowerCase().includes(customerQuery.toLowerCase()) ||
        (c.city || '').toLowerCase().includes(customerQuery.toLowerCase()) ||
        (c.address || '').toLowerCase().includes(customerQuery.toLowerCase())
      )
    : []

  const showCreateOption = customerQuery.length >= 2 &&
    !filteredCustomers.some(c => c.name.toLowerCase() === customerQuery.toLowerCase())

  const filteredBilling = billingQuery.length >= 1
    ? billingAccounts.filter(b => b.name.toLowerCase().includes(billingQuery.toLowerCase()))
    : []

  const showCreateBillingOption = billingQuery.length >= 2 &&
    !filteredBilling.some(b => b.name.toLowerCase() === billingQuery.toLowerCase())

  function toggleScope(s: string) {
    setScope(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])
  }

  async function createJob() {
    if (saving) return
    if (!selectedLocation && !creatingNew) return
    setSaving(true)

    try {
      let locationId = selectedLocation?.id
      let billingAccountId = selectedLocation?.billing_account_id || null

      if (billingDifferent) {
        if (selectedBilling) {
          billingAccountId = selectedBilling.id
        } else if (creatingNewBilling && newBillingName) {
          const { data: ba, error: baErr } = await supabase
            .from('billing_accounts')
            .insert({ name: newBillingName, contact_name: newBillingContact || null, phone: newBillingPhone || null, email: newBillingEmail || null })
            .select().single()
          if (baErr) throw baErr
          billingAccountId = ba.id
        }
      }

      if (creatingNew) {
        const { data: loc, error: locErr } = await supabase
          .from('locations')
          .insert({ name: newName, address: newAddress || null, city: newCity || null, state: newState || 'TX', zip: newZip || null, contact_name: newContact || null, contact_phone: newPhone || null, contact_email: newEmail || null, billing_account_id: billingAccountId })
          .select().single()
        if (locErr) throw locErr
        locationId = loc.id
      }

      const { error: jobErr } = await supabase.from('jobs').insert({
        location_id: locationId, billing_account_id: billingAccountId, type, scope, scheduled_date: date, scheduled_time: time, status: 'scheduled', notes: notes || null,
      })
      if (jobErr) throw jobErr

      onCreated()
    } catch (err) {
      console.error('Create job error:', err)
      alert('Error creating job')
    }
    setSaving(false)
  }

  const canSubmit = (selectedLocation || (creatingNew && newName)) && date

  return (
    <div className="fixed inset-0 z-[200] bg-[#0a0c10] overflow-y-auto">
      <div className="sticky top-0 z-10 bg-[#0a0c10] px-4 py-3 flex items-center gap-3 border-b border-[#2a3040]">
        <button onClick={onClose} className="text-2xl text-gray-300 p-1">←</button>
        <div className="text-[17px] font-bold">New Job</div>
      </div>

      <div className="px-4 pt-4 pb-32">

        {/* CUSTOMER */}
        <div className="mb-4 relative">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Customer</label>

          {selectedLocation && !creatingNew ? (
            <div className="bg-[#12151c] border border-emerald-500/30 rounded-lg p-3">
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-sm font-bold text-emerald-400">{selectedLocation.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{[selectedLocation.address, selectedLocation.city].filter(Boolean).join(', ')}</div>
                </div>
                <button onClick={() => { setSelectedLocation(null); setCustomerQuery(''); }} className="text-xs text-gray-500 px-2 py-1">Change</button>
              </div>
            </div>
          ) : !creatingNew ? (
            <>
              <input type="text" value={customerQuery}
                onChange={e => { setCustomerQuery(e.target.value); setShowResults(true); }}
                onFocus={() => setShowResults(true)}
                placeholder="Start typing customer name..."
                className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]" />

              {showResults && customerQuery.length >= 1 && (
                <div className="absolute left-0 right-0 mt-1 bg-[#1a1e28] border border-[#2a3040] rounded-lg overflow-hidden z-20 max-h-64 overflow-y-auto shadow-xl">
                  {filteredCustomers.map(c => (
                    <button key={c.id} onClick={() => { setSelectedLocation(c); setCustomerQuery(c.name); setShowResults(false); }}
                      className="w-full text-left px-3 py-2.5 border-b border-[#2a3040] last:border-0 active:bg-[#222735]">
                      <div className="text-sm font-semibold">{c.name}</div>
                      <div className="text-[11px] text-gray-500">{[c.address, c.city].filter(Boolean).join(', ')}</div>
                    </button>
                  ))}
                  {showCreateOption && (
                    <button onClick={() => { setCreatingNew(true); setNewName(customerQuery); setShowResults(false); }}
                      className="w-full text-left px-3 py-3 bg-[#e85d26]/5 active:bg-[#e85d26]/10">
                      <div className="text-sm font-bold text-[#e85d26]">+ Create "{customerQuery}"</div>
                      <div className="text-[11px] text-gray-500">Add as new customer</div>
                    </button>
                  )}
                  {filteredCustomers.length === 0 && !showCreateOption && (
                    <div className="px-3 py-3 text-sm text-gray-500">Keep typing to search or create...</div>
                  )}
                </div>
              )}
            </>
          ) : null}

          {creatingNew && (
            <div className="bg-[#12151c] border border-[#e85d26]/30 rounded-lg p-3 mt-1">
              <div className="flex justify-between items-center mb-3">
                <div className="text-xs font-bold text-[#e85d26] uppercase tracking-wider">New Customer</div>
                <button onClick={() => { setCreatingNew(false); setCustomerQuery(''); }} className="text-xs text-gray-500">Cancel</button>
              </div>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Business name"
                className="w-full px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26] mb-2" />
              <input type="text" value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder="Address"
                className="w-full px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26] mb-2" />
              <div className="grid grid-cols-3 gap-2 mb-2">
                <input type="text" value={newCity} onChange={e => setNewCity(e.target.value)} placeholder="City"
                  className="px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
                <input type="text" value={newState} onChange={e => setNewState(e.target.value)} placeholder="ST"
                  className="px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
                <input type="text" value={newZip} onChange={e => setNewZip(e.target.value)} placeholder="Zip"
                  className="px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input type="text" value={newContact} onChange={e => setNewContact(e.target.value)} placeholder="Contact name"
                  className="px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
                <input type="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="Phone"
                  className="px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
              </div>
              <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="Email (optional)"
                className="w-full px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
            </div>
          )}
        </div>

        {/* BILLING */}
        <div className="mb-4">
          <button onClick={() => setBillingDifferent(!billingDifferent)}
            className={`w-full py-2.5 rounded-lg text-xs font-semibold border transition-colors ${billingDifferent ? 'bg-[#e85d26]/10 text-[#e85d26] border-[#e85d26]' : 'bg-[#12151c] text-gray-500 border-[#2a3040]'}`}>
            {billingDifferent ? '✓ Bills to different entity' : 'Bills to a different entity?'}
          </button>

          {billingDifferent && (
            <div className="mt-2 relative">
              {selectedBilling && !creatingNewBilling ? (
                <div className="bg-[#12151c] border border-emerald-500/30 rounded-lg p-3">
                  <div className="flex justify-between items-center">
                    <div className="text-sm font-bold text-emerald-400">{selectedBilling.name}</div>
                    <button onClick={() => { setSelectedBilling(null); setBillingQuery(''); }} className="text-xs text-gray-500">Change</button>
                  </div>
                </div>
              ) : !creatingNewBilling ? (
                <>
                  <input type="text" value={billingQuery}
                    onChange={e => { setBillingQuery(e.target.value); setShowBillingResults(true); }}
                    onFocus={() => setShowBillingResults(true)}
                    placeholder="Search or create billing account..."
                    className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]" />
                  {showBillingResults && billingQuery.length >= 1 && (
                    <div className="absolute left-0 right-0 mt-1 bg-[#1a1e28] border border-[#2a3040] rounded-lg overflow-hidden z-20 max-h-48 overflow-y-auto shadow-xl">
                      {filteredBilling.map(b => (
                        <button key={b.id} onClick={() => { setSelectedBilling(b); setBillingQuery(b.name); setShowBillingResults(false); }}
                          className="w-full text-left px-3 py-2.5 border-b border-[#2a3040] last:border-0 active:bg-[#222735]">
                          <div className="text-sm font-semibold">{b.name}</div>
                        </button>
                      ))}
                      {showCreateBillingOption && (
                        <button onClick={() => { setCreatingNewBilling(true); setNewBillingName(billingQuery); setShowBillingResults(false); }}
                          className="w-full text-left px-3 py-3 bg-[#e85d26]/5">
                          <div className="text-sm font-bold text-[#e85d26]">+ Create "{billingQuery}"</div>
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="bg-[#12151c] border border-[#e85d26]/30 rounded-lg p-3">
                  <div className="flex justify-between items-center mb-2">
                    <div className="text-xs font-bold text-[#e85d26] uppercase tracking-wider">New Billing Account</div>
                    <button onClick={() => { setCreatingNewBilling(false); setBillingQuery(''); }} className="text-xs text-gray-500">Cancel</button>
                  </div>
                  <input type="text" value={newBillingName} onChange={e => setNewBillingName(e.target.value)} placeholder="Company name"
                    className="w-full px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26] mb-2" />
                  <div className="grid grid-cols-2 gap-2">
                    <input type="text" value={newBillingContact} onChange={e => setNewBillingContact(e.target.value)} placeholder="Contact"
                      className="px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
                    <input type="tel" value={newBillingPhone} onChange={e => setNewBillingPhone(e.target.value)} placeholder="Phone"
                      className="px-3 py-2.5 bg-[#1a1e28] border border-[#2a3040] rounded-lg text-sm text-gray-200 outline-none focus:border-[#e85d26]" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* DATE & TIME */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]" />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Time</label>
            <input type="time" value={time} onChange={e => setTime(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]" />
          </div>
        </div>

        {/* CALL TYPE */}
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Call Type</label>
          <div className="flex flex-wrap gap-1.5">
            {[{id:'inspection',label:'Inspection'},{id:'emergency',label:'Emergency $500'},{id:'emergency_after_hrs',label:'After Hrs $750'},{id:'emergency_holiday',label:'Holiday $1K'},{id:'misc',label:'Misc'}].map(t => (
              <button key={t.id} onClick={() => setType(t.id)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${type === t.id ? 'bg-[#e85d26]/10 text-[#e85d26] border-[#e85d26]' : 'bg-[#12151c] text-gray-500 border-[#2a3040]'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* SCOPE */}
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Scope</label>
          <div className="flex flex-wrap gap-1.5">
            {[{id:'extinguishers',label:'Extinguishers'},{id:'suppression',label:'Suppression'},{id:'elights',label:'Emergency Lights'},{id:'hydro',label:'Hydro Testing'}].map(s => (
              <button key={s.id} onClick={() => toggleScope(s.id)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${scope.includes(s.id) ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500' : 'bg-[#12151c] text-gray-500 border-[#2a3040]'}`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* NOTES */}
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any notes..."
            className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26] h-20 resize-none" />
        </div>

        <button onClick={createJob} disabled={!canSubmit || saving}
          className="w-full py-4 bg-[#e85d26] text-white rounded-xl text-base font-bold active:opacity-80 disabled:opacity-50">
          {saving ? 'Creating...' : 'Create Job'}
        </button>
      </div>
    </div>
  )
}
