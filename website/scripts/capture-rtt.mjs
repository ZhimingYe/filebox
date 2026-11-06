export async function waitForLocalRtt(page) {
  if (await page.$('#fb-username')) return null
  const result = await page.waitForFunction(async () => {
    const cookie = document.cookie.split('; ').find((c) => c.startsWith('filebox_csrf_'))
    if (!cookie) return false
    const response = await fetch('/api/agents', {
      headers: { 'X-CSRF-Token': decodeURIComponent(cookie.split('=')[1]) },
    })
    if (!response.ok) return false
    const agents = await response.json()
    const agent = agents.find((a) => a.name === 'lab-server')
    return agent?.status === 'online' && agent.rtt_ms !== null && agent.rtt_ms <= 250
      ? { rtt_ms: agent.rtt_ms } : false
  }, { polling: 1000, timeout: 60000 })
  return (await result.jsonValue()).rtt_ms
}
