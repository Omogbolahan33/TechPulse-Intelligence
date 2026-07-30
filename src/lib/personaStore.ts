import { create } from 'zustand';

interface PersonaState {
  userPersona: string | null;
  setUserPersona: (persona: string) => void;
  hasSeenOnboarding: boolean;
  completeOnboarding: () => void;
}

export const usePersonaStore = create<PersonaState>((set) => ({
  userPersona: localStorage.getItem('enigma_user_persona'),
  hasSeenOnboarding: localStorage.getItem('enigma_onboarding_complete') === 'true',
  setUserPersona: (persona: string) => {
    localStorage.setItem('enigma_user_persona', persona);
    set({ userPersona: persona });
  },
  completeOnboarding: () => {
    localStorage.setItem('enigma_onboarding_complete', 'true');
    set({ hasSeenOnboarding: true });
  }
}));
