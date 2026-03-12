'use client'

import { useState } from 'react'
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
  const [locationId, setLocationId] = useState('')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [time, setTime] = useState('09:00')
  const [type, setType] = useState('inspection')
  const [scope, setScope] = useState<string[]>(['extinguishers', 'suppression'])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  function toggleScope(s: string) {
    setScope(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])
  }

  async function createJob() {
    if (!locationId || saving) return
    setSaving(true)

    const loc = customers.find(c => c.id === locationId)

    const { error } = await supabase.from('jobs').insert({
      location_id: locationId,
      billing_account_id: loc?.billing_account_id || null,
      type,
      scope,
      scheduled_date: date,
      scheduled_time: time,
      status: 'scheduled',
      notes,
    })

    if (error) {
      console.error('Create job error:', error)
      alert('Error creating job')
    } else {
      onCreated()
    }

    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-[200] bg-[#0a0c10] overflow-y-auto">
      <div className="sticky top-0 z-10 bg-[#0a0c10] px-4 py-3 flex items-center gap-3 border-b border-[#2a3040]">
        <button onClick={onClose} className="text-2xl text-gray-300 p-1">←</button>
        <div className="text-[17px] font-bold">New Job</div>
      </div>

      <div className="px-4 pt-4 pb-32">
        {/* Location */}
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Location</label>
          <select
            value={locationId}
            onChange={e => setLocationId(e.target.value)}
            className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26] appearance-none"
          >
            <option value="">Select a customer location...</option>
            {customers.map(c => (
              <option key={c.id} value={c.id}>{c.name} — {c.city}</option>
            ))}
          </select>
        </div>

        {/* Date & Time */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Time</label>
            <input
              type="time"
              value={time}
              onChange={e => setTime(e.target.value)}
              className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26]"
            />
          </div>
        </div>

        {/* Type */}
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Call Type</label>
          <div className="flex flex-wrap gap-1.5">
            {[
              { id: 'inspection', label: 'Inspection' },
              { id: 'emergency', label: 'Emergency $500' },
              { id: 'emergency_after_hrs', label: 'After Hours $750' },
              { id: 'emergency_holiday', label: 'Holiday $1,000' },
              { id: 'misc', label: 'Misc' },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => setType(t.id)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  type === t.id
                    ? 'bg-[#e85d26]/10 text-[#e85d26] border-[#e85d26]'
                    : 'bg-[#12151c] text-gray-500 border-[#2a3040]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scope */}
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Scope</label>
          <div className="flex flex-wrap gap-1.5">
            {[
              { id: 'extinguishers', label: 'Extinguishers' },
              { id: 'suppression', label: 'Suppression' },
              { id: 'elights', label: 'Emergency Lights' },
              { id: 'hydro', label: 'Hydro Testing' },
            ].map(s => (
              <button
                key={s.id}
                onClick={() => toggleScope(s.id)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  scope.includes(s.id)
                    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500'
                    : 'bg-[#12151c] text-gray-500 border-[#2a3040]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Any notes for this job..."
            className="w-full px-3 py-3 bg-[#12151c] border border-[#2a3040] rounded-lg text-[15px] text-gray-200 outline-none focus:border-[#e85d26] h-20 resize-none"
          />
        </div>

        <button
          onClick={createJob}
          disabled={!locationId || saving}
          className="w-full py-4 bg-[#e85d26] text-white rounded-xl text-base font-bold active:opacity-80 disabled:opacity-50"
        >
          {saving ? 'Creating...' : 'Create Job'}
        </button>
      </div>
    </div>
  )
}
