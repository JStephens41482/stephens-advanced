module.exports = async function handler(req, res) {
  const base = 'https://www.stephensadvanced.com'
  const pages = [
    { loc: '/', freq: 'weekly', priority: '1.0' },
    { loc: '/apply', freq: 'monthly', priority: '0.5' },
    // Service pages
    { loc: '/services/fire-extinguisher-inspection', freq: 'monthly', priority: '0.8' },
    { loc: '/services/kitchen-suppression-inspection', freq: 'monthly', priority: '0.8' },
    { loc: '/services/hydrostatic-testing', freq: 'monthly', priority: '0.8' },
    { loc: '/services/semi-annual-inspection', freq: 'monthly', priority: '0.8' },
    { loc: '/services/emergency-lighting', freq: 'monthly', priority: '0.8' },
    { loc: '/services/system-installation', freq: 'monthly', priority: '0.8' },
    { loc: '/services/recharge-service', freq: 'monthly', priority: '0.8' },
    { loc: '/services/captive-aire-service', freq: 'monthly', priority: '0.8' },
    // System pages
    { loc: '/systems/ansul-r102', freq: 'monthly', priority: '0.7' },
    { loc: '/systems/pyro-chem-kitchen-knight', freq: 'monthly', priority: '0.7' },
    { loc: '/systems/buckeye-kitchen-mister', freq: 'monthly', priority: '0.7' },
    { loc: '/systems/kidde-whdr', freq: 'monthly', priority: '0.7' },
    { loc: '/systems/captive-aire-tank', freq: 'monthly', priority: '0.7' },
    // City pages
    { loc: '/areas/dallas', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/fort-worth', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/arlington', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/plano', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/frisco', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/mckinney', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/richardson', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/irving', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/garland', freq: 'yearly', priority: '0.6' },
    { loc: '/areas/denton', freq: 'yearly', priority: '0.6' },
  ]

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${base}${p.loc}</loc>
    <changefreq>${p.freq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`

  res.setHeader('Content-Type', 'application/xml')
  res.status(200).send(xml)
}
