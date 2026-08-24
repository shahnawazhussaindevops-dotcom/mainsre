-- Run this in your Supabase SQL Editor

-- 1. Create Servers Table
CREATE TABLE IF NOT EXISTS public.servers (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    username TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    password TEXT,
    "privateKey" TEXT,
    passphrase TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;

-- Create Policy: Users can only see and manage their own servers
CREATE POLICY "Users can manage their own servers"
ON public.servers
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
