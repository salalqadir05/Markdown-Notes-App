import { useCallback, useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { exists, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { load } from '@tauri-apps/plugin-store'
import { basename, join } from '@tauri-apps/api/path'
import { marked } from 'marked'
import './App.css'

type NoteNode = {
  name: string
  path: string
  isDirectory: boolean
  children?: NoteNode[]
}

type NoteListItem = {
  name: string
  path: string
  directory: string
}

const STORE_FILE = 'config.json'
const LAST_FOLDER_KEY = 'lastOpenedFolder'
const EMPTY_NOTE = '# Untitled note\n'

async function loadFolderTree(folderPath: string): Promise<NoteNode[]> {
  const entries = await readDir(folderPath)
  const nodes: Array<NoteNode | null> = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = await join(folderPath, entry.name)

      if (entry.isDirectory) {
        const children = await loadFolderTree(entryPath)
        if (children.length === 0) {
          return null
        }

        return {
          name: entry.name,
          path: entryPath,
          isDirectory: true,
          children,
        } satisfies NoteNode
      }

      if (!entry.isFile || !entry.name.toLowerCase().endsWith('.md')) {
        return null
      }

      return {
        name: entry.name,
        path: entryPath,
        isDirectory: false,
      } satisfies NoteNode
    }),
  )

  return nodes
    .filter((node): node is NoteNode => node !== null)
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
}

function flattenNotes(nodes: NoteNode[], parentPath = ''): NoteListItem[] {
  return nodes.flatMap((node) => {
    if (node.isDirectory) {
      return flattenNotes(node.children ?? [], node.path)
    }

    return [{ name: node.name, path: node.path, directory: parentPath || '.' }]
  })
}

function fuzzyScore(value: string, query: string): number {
  if (!query) {
    return 1
  }

  const haystack = value.toLowerCase()
  const needle = query.toLowerCase()
  let score = 0
  let searchIndex = 0
  let consecutiveBonus = 0

  for (const char of needle) {
    const matchIndex = haystack.indexOf(char, searchIndex)
    if (matchIndex === -1) {
      return -1
    }

    score += 1
    if (matchIndex === searchIndex) {
      consecutiveBonus += 2
      score += consecutiveBonus
    } else {
      consecutiveBonus = 0
      score -= matchIndex - searchIndex
    }

    searchIndex = matchIndex + 1
  }

  return score - (haystack.length - needle.length)
}

function renderTree(
  nodes: NoteNode[],
  selectedPath: string | null,
  onSelect: (path: string) => void,
): React.JSX.Element {
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.isDirectory ? (
            <details open className="tree-folder">
              <summary>{node.name}</summary>
              {renderTree(node.children ?? [], selectedPath, onSelect)}
            </details>
          ) : (
            <button
              type="button"
              className={`tree-file ${selectedPath === node.path ? 'selected' : ''}`}
              onClick={() => onSelect(node.path)}
            >
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function App() {
  const [storeReady, setStoreReady] = useState(false)
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [tree, setTree] = useState<NoteNode[]>([])
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null)
  const [noteTitle, setNoteTitle] = useState('No note selected')
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [status, setStatus] = useState('Choose a folder to start.')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isBusy, setIsBusy] = useState(false)

  const allNotes = useMemo(() => flattenNotes(tree), [tree])
  const isDirty = selectedNotePath !== null && content !== savedContent
  const previewHtml = useMemo(
    () => marked.parse(content || '*Start typing to preview your Markdown...*', { async: false }),
    [content],
  )

  const openNote = useCallback(async (path: string, nextTree = tree) => {
    const fileContent = await readTextFile(path)
    const nextTitle = await basename(path)

    setSelectedNotePath(path)
    setNoteTitle(nextTitle)
    setContent(fileContent)
    setSavedContent(fileContent)

    const noteExistsInTree = flattenNotes(nextTree).some((note) => note.path === path)
    if (noteExistsInTree) {
      setStatus(`Editing ${nextTitle}`)
    }
  }, [tree])

  const refreshTree = useCallback(async (nextFolderPath: string, preferredPath?: string | null) => {
    const nextTree = await loadFolderTree(nextFolderPath)
    const noteList = flattenNotes(nextTree)
    const fallbackPath = preferredPath ?? noteList[0]?.path ?? null

    setTree(nextTree)

    if (fallbackPath) {
      await openNote(fallbackPath, nextTree)
    } else {
      setSelectedNotePath(null)
      setNoteTitle('No notes in folder')
      setContent('')
      setSavedContent('')
      setStatus('This folder has no Markdown files yet. Press Ctrl+N to create one.')
    }
  }, [openNote])

  const rememberFolder = useCallback(async (nextFolderPath: string) => {
    const store = await load(STORE_FILE)
    await store.set(LAST_FOLDER_KEY, nextFolderPath)
    await store.save()
  }, [])

  const chooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Choose notes folder',
    })

    if (!selected) {
      return
    }

    setIsBusy(true)
    try {
      setFolderPath(selected)
      await rememberFolder(selected)
      await refreshTree(selected)
      setStatus(`Loaded notes from ${selected}`)
    } finally {
      setIsBusy(false)
    }
  }, [refreshTree, rememberFolder])

  const saveCurrentNote = useCallback(async () => {
    if (!selectedNotePath) {
      setStatus('Open or create a note before saving.')
      return
    }

    setIsBusy(true)
    try {
      await writeTextFile(selectedNotePath, content)
      setSavedContent(content)
      setStatus(`Saved ${noteTitle}`)
    } finally {
      setIsBusy(false)
    }
  }, [content, noteTitle, selectedNotePath])

  const createNote = useCallback(async () => {
    let workingFolder = folderPath

    if (!workingFolder) {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose folder for your new note',
      })

      if (!selected) {
        return
      }

      workingFolder = selected
      setFolderPath(selected)
      await rememberFolder(selected)
    }

    setIsBusy(true)
    try {
      let counter = 1
      let nextPath = await join(workingFolder, 'untitled.md')

      while (await exists(nextPath)) {
        counter += 1
        nextPath = await join(workingFolder, `untitled-${counter}.md`)
      }

      await writeTextFile(nextPath, EMPTY_NOTE)
      await refreshTree(workingFolder, nextPath)
      setStatus(`Created ${await basename(nextPath)}`)
    } finally {
      setIsBusy(false)
    }
  }, [folderPath, refreshTree, rememberFolder])

  useEffect(() => {
    let cancelled = false

    async function restoreLastFolder() {
      try {
        const store = await load(STORE_FILE)
        const lastFolder = await store.get<string>(LAST_FOLDER_KEY)

        if (!lastFolder || !(await exists(lastFolder))) {
          return
        }

        if (cancelled) {
          return
        }

        setFolderPath(lastFolder)
        await refreshTree(lastFolder)
        setStatus(`Restored notes from ${lastFolder}`)
      } catch (error) {
        console.error('Failed to restore notes folder', error)
      } finally {
        if (!cancelled) {
          setStoreReady(true)
        }
      }
    }

    void restoreLastFolder()

    return () => {
      cancelled = true
    }
  }, [refreshTree])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        return
      }

      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      const shortcut = event.key.toLowerCase()
      if (shortcut === 's') {
        event.preventDefault()
        void saveCurrentNote()
      } else if (shortcut === 'n') {
        event.preventDefault()
        void createNote()
      } else if (shortcut === 'f') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [createNote, saveCurrentNote, searchOpen])

  const searchResults = useMemo(() => {
    return [...allNotes]
      .map((note) => ({
        ...note,
        score: fuzzyScore(note.name, searchQuery),
      }))
      .filter((note) => note.score >= 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 12)
  }, [allNotes, searchQuery])

  async function handleSelectFromSearch(path: string) {
    await openNote(path)
    setSearchOpen(false)
    setSearchQuery('')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Rust Markdown Notes</h1>
          <p>{folderPath ?? 'No folder selected'}</p>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => void chooseFolder()} disabled={isBusy}>
            Open Folder
          </button>
          <button type="button" onClick={() => void createNote()} disabled={isBusy || !storeReady}>
            New Note
          </button>
          <button type="button" onClick={() => void saveCurrentNote()} disabled={isBusy || !isDirty}>
            Save
          </button>
        </div>
      </header>

      <main className="panes">
        <aside className="pane sidebar">
          <div className="pane-header">
            <h2>Notes</h2>
            <span>{allNotes.length}</span>
          </div>
          <p className="shortcut-hint">Ctrl/Cmd+F search, Ctrl/Cmd+N new note</p>
          {tree.length > 0 ? (
            renderTree(tree, selectedNotePath, (path) => void openNote(path))
          ) : (
            <div className="empty-state">
              <p>No Markdown notes loaded yet.</p>
              <button type="button" onClick={() => void chooseFolder()}>
                Choose Folder
              </button>
            </div>
          )}
        </aside>

        <section className="pane editor-pane">
          <div className="pane-header">
            <h2>{noteTitle}</h2>
            <span>{isDirty ? 'Unsaved changes' : 'Saved'}</span>
          </div>
          <textarea
            className="editor"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Write Markdown here..."
            spellCheck={false}
          />
        </section>

        <section className="pane preview-pane">
          <div className="pane-header">
            <h2>Preview</h2>
            <span>{content.length} chars</span>
          </div>
          <article
            className="preview"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </section>
      </main>

      <footer className="statusbar">
        <span>{status}</span>
        {selectedNotePath ? <span>{selectedNotePath}</span> : null}
      </footer>

      {searchOpen ? (
        <div
          className="search-overlay"
          role="presentation"
          onClick={() => {
            setSearchOpen(false)
            setSearchQuery('')
          }}
        >
          <div
            className="search-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Search notes"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              className="search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search filenames..."
            />
            <div className="search-results">
              {searchResults.length > 0 ? (
                searchResults.map((note) => (
                  <button
                    key={note.path}
                    type="button"
                    className="search-result"
                    onClick={() => void handleSelectFromSearch(note.path)}
                  >
                    <strong>{note.name}</strong>
                    <span>{note.directory}</span>
                  </button>
                ))
              ) : (
                <p className="search-empty">No matches.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
