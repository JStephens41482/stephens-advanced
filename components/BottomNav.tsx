'use client'

export default function BottomNav({ 
  active, 
  onChange 
}: { 
  active: string
  onChange: (view: string) => void 
}) {
  const tabs = [
    { id: 'today', icon: '⚡', label: 'Today' },
    { id: 'schedule', icon: '📅', label: 'Schedule' },
    { id: 'customers', icon: '👤', label: 'Customers' },
    { id: 'money', icon: '💰', label: 'Money' },
  ]

  return (
    <div className="flex bg-[#12151c] border-t border-[#2a3040] pb-7 pt-2 flex-shrink-0 z-50">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 flex flex-col items-center gap-1 py-1 transition-colors ${
            active === tab.id ? 'text-[#e85d26]' : 'text-[#4a5060]'
          }`}
        >
          <span className="text-xl leading-none">{tab.icon}</span>
          <span className="text-[10px] font-semibold tracking-wide">{tab.label}</span>
        </button>
      ))}
    </div>
  )
}
