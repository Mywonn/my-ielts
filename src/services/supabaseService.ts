import { createClient } from '@supabase/supabase-js'

let supabase

const getSupabaseClient = (url, key) => {
  if (!supabase || supabase.supabaseUrl !== url) {
    if (!url || !key) {
      console.error('Supabase URL or Key is not configured.')
      return null
    }
    supabase = createClient(url, key)
  }
  return supabase
}

// --- Database Operations ---

export const syncHistoryToSupabase = async (url, key, history) => {
  const client = getSupabaseClient(url, key)
  if (!client) throw new Error('Supabase client not initialized.')

  const { data, error } = await client
    .from('learning_history')
    .upsert(history, { onConflict: 'id', ignoreDuplicates: false })

  if (error) throw error
  return data
}

export const fetchHistoryFromSupabase = async (url, key) => {
  const client = getSupabaseClient(url, key)
  if (!client) throw new Error('Supabase client not initialized.')

  const { data, error } = await client
    .from('learning_history')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
}

// --- Storage Operations ---

const BUCKET_NAME = 'learning-assets'

export const uploadFileToSupabase = async (url, key, path, file) => {
  const client = getSupabaseClient(url, key)
  if (!client) throw new Error('Supabase client not initialized.')

  const { data, error } = await client.storage
    .from(BUCKET_NAME)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: true // Overwrite if exists
    })

  if (error) throw error
  return data
}

export const downloadFileFromSupabase = async (url, key, path) => {
  const client = getSupabaseClient(url, key)
  if (!client) throw new Error('Supabase client not initialized.')

  const { data, error } = await client.storage
    .from(BUCKET_NAME)
    .download(path)

  if (error) throw error
  return data
}
