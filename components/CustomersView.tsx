'use client'

import { useState } from 'react'

export default function CustomersView({
  customers,
  onOpenCustomer,
}: {
  customers: any[]
  onOpenCustomer: (id: string) => void
}) {
  const [search, setSearch] = useState('')

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.address || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.city || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mt-5 mb-3">Customers</div>

      <input
        type="text"
        placeholder="Search customers..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full px-3.5 py-3 bg-[#12151c] border border-[#2a3040] rounded-xl text-[15px] text-gray-200 outline-none focus:border-[#e85d26] mb-3"
      />

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3 opacity-30">👤</div>
          <div className="text-sm">No customers found.</div>
        </div>
      ) : (
        filtered.map(c => (
          <div
            key={c.id}
            onClick={() => onOpenCustomer(c.id)}
            className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3.5 mb-2 cursor-pointer active:border-[#e85d26] transition-colors"
          >
            <div className="text-[15px] font-bold">{c.name}</div>
            <div className="text-xs text-gray-500 mt-0.5">{c.address}, {c.city}</div>
            <div className="flex gap-3 mt-2">
              <div className="text-[11px] text-gray-500">
                <strong className="text-gray-300 font-semibold">{c.extinguishers?.length || 0}</strong> extinguishers
              </div>
              <div className="text-[11px] text-gray-500">
                <strong className="text-gray-300 font-semibold">{c.suppression_systems?.length || 0}</strong> systems
              </div>
              {c.billing_account && (
                <div className="text-[11px] text-gray-500">
                  Bills to: <strong className="text-gray-300 font-semibold">{c.billing_account.name}</strong>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
