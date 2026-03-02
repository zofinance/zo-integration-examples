import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '@zofai/trading-widget/style.css'

import { DAppKitProvider } from '@mysten/dapp-kit-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { appStore } from '@zofai/trading-widget'
import { Provider as JotaiProvider } from 'jotai'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { dAppKit } from './dapp-kit'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      retry: 2,
    },
  },
})

const root = document.querySelector('#root')
if (!root)
  throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <JotaiProvider store={appStore}>
      <QueryClientProvider client={queryClient}>
        <DAppKitProvider dAppKit={dAppKit}>
          <App />
        </DAppKitProvider>
      </QueryClientProvider>
    </JotaiProvider>
  </StrictMode>,
)
