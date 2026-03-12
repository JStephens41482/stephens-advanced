'use client'

function formatMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function MoneyView({
  invoices,
  collected,
  outstanding,
}: {
  invoices: any[]
  collected: number
  outstanding: number
}) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 mt-2 mb-1">
        <div className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3 text-center">
          <div className="font-mono text-xl font-bold text-emerald-500">{formatMoney(collected)}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mt-1">Collected (30d)</div>
        </div>
        <div className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3 text-center">
          <div className="font-mono text-xl font-bold text-red-500">{formatMoney(outstanding)}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mt-1">Outstanding</div>
        </div>
      </div>

      <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mt-5 mb-3">Recent Invoices</div>

      {invoices.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3 opacity-30">💰</div>
          <div className="text-sm">No invoices yet.</div>
        </div>
      ) : (
        invoices.map(inv => (
          <div key={inv.id} className="bg-[#12151c] border border-[#2a3040] rounded-xl p-3.5 mb-2">
            <div className="flex justify-between items-start mb-1">
              <div className="text-sm font-bold">{inv.invoice_number}</div>
              <div className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                inv.status === 'paid' ? 'bg-emerald-500/10 text-emerald-500' :
                inv.status === 'overdue' ? 'bg-red-500/10 text-red-500' :
                inv.status === 'sent' ? 'bg-blue-500/10 text-blue-500' :
                inv.status === 'viewed' ? 'bg-yellow-500/10 text-yellow-500' :
                'bg-gray-500/10 text-gray-500'
              }`}>
                {inv.status}
              </div>
            </div>
            <div className="text-xs text-gray-500">
              {new Date(inv.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </div>
            <div className="font-mono text-sm font-semibold text-gray-200 mt-1">
              {formatMoney(Number(inv.total))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
