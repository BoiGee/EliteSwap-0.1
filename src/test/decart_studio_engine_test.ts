import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import DecartStudioEngine from '@/components/DeepfakeStudio';
import useDecartRealtime from '@/hooks/useDecartRealtime';
import { createClient } from '@supabase/supabase-js';

const API_ENDPOINT = 'https://api.decart.ai/v1/studio';
const PAYLOAD_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB

describe('Decart Studio Engine', () => {
  let supabase: ReturnType<typeof createClient>;

  beforeEach(() => {
    supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );
  });

  it('renders without errors when user session exists', async () => {
    const mockSession = await supabase.auth.createSession({
      provider: 'email',
      email: 'test@example.com',
      password: 'password123',
    });

    render(
      <DecartStudioEngine
        endpoint={API_ENDPOINT}
        payloadSizeLimit={PAYLOAD_SIZE_LIMIT}
        userSession={mockSession.user as any}
      />
    );

    expect(screen.getByRole('button')).toBeInTheDocument();
  });
});