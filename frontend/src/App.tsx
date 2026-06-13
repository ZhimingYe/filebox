import { useEffect, useState } from 'react'

function App() {
  const [health, setHealth] = useState<string>('checking...')

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => setHealth(data.status))
      .catch(() => setHealth('unreachable'))
  }, [])

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>filebox</h1>
      <p>Hub status: {health}</p>
    </div>
  )
}

export default App
