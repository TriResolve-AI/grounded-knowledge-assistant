import { useState } from 'react'
import './App.css'

function App() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [validation, setValidation] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000'

  const handleSearch = async () => {
    if (!query.trim()) return

    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${API_BASE}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      setResults(data.results || [])
    } catch (err) {
      setError(`Search failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleValidate = async () => {
    if (!query.trim()) return

    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${API_BASE}/govern`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'query', content: query }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      setValidation(data)
    } catch (err) {
      setError(`Validation failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Governed RAG Backend</h1>
        <p>Search for governance and compliance tools with AI-powered enhancement</p>
      </header>

      <main>
        <div className="search-section">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter your search query..."
            className="query-input"
          />
          <div className="buttons">
            <button onClick={handleSearch} disabled={loading || !query.trim()}>
              {loading ? 'Searching...' : 'Search Tools'}
            </button>
            <button onClick={handleValidate} disabled={loading || !query.trim()}>
              {loading ? 'Validating...' : 'Validate Query'}
            </button>
          </div>
        </div>

        {error && (
          <div className="error">
            {error}
          </div>
        )}

        {validation && (
          <div className="validation-result">
            <h3>Validation Result</h3>
            <p>Approved: {validation.approved ? 'Yes' : 'No'}</p>
            {validation.reason && <p>Reason: {validation.reason}</p>}
          </div>
        )}

        {results.length > 0 && (
          <div className="results">
            <h3>Search Results</h3>
            <button onClick={handleSearch} disabled={loading} className="refresh-button">
              Refresh Results
            </button>
            <ul>
              {results.map((tool, index) => {
                const toolSlug = tool.name.toLowerCase().replace(/\s+/g, '-');
                const toolUrl = tool.url || `https://example.com/tools/${toolSlug}`;
                return (
                  <li key={index}>
                    <a href={toolUrl} target="_blank" rel="noopener noreferrer">
                      <strong>{tool.name}</strong>
                    </a>
                    : {tool.description}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
