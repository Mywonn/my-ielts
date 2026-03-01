
/**
 * Services for syncing data with GitHub Gist.
 */

/**
 * Fetches the content of a file from a GitHub Gist.
 * 
 * @param {string} token - GitHub Personal Access Token.
 * @param {string} gistId - The ID of the Gist.
 * @param {string} filename - The name of the file within the Gist.
 * @returns {Promise<any>} - The parsed JSON content or null if not found.
 */
export async function fetchGistFile(token, gistId, filename) {
    if (!token || !gistId) return null

    try {
        const response = await fetch(`https://api.github.com/gists/${gistId}`, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        })

        if (response.status === 404) return null
        if (!response.ok) throw new Error(`GitHub API Error: ${response.status}`)

        const data = await response.json()
        const file = data.files[filename]
        
        if (!file) return null // File not found in Gist
        
        // Gist content is usually raw string
        return JSON.parse(file.content)
    } catch (error) {
        console.error('Failed to fetch from GitHub Gist:', error)
        throw error
    }
}

/**
 * Updates a file in a GitHub Gist.
 * 
 * @param {string} token - GitHub Personal Access Token.
 * @param {string} gistId - The ID of the Gist.
 * @param {string} filename - The name of the file to update/create.
 * @param {any} content - The content to save (will be stringified to JSON).
 * @param {string} description - Gist description (optional).
 */
export async function updateGistFile(token, gistId, filename, content, description = 'My IELTS Master Data') {
    if (!token || !gistId) throw new Error('Missing GitHub credentials')

    try {
        const body = {
            description,
            files: {
                [filename]: {
                    content: JSON.stringify(content, null, 2)
                }
            }
        }

        const response = await fetch(`https://api.github.com/gists/${gistId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `token ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        })

        if (!response.ok) {
            const err = await response.json()
            throw new Error(err.message || 'Failed to update GitHub Gist')
        }

        return await response.json()
    } catch (error) {
        console.error('Failed to update GitHub Gist:', error)
        throw error
    }
}
