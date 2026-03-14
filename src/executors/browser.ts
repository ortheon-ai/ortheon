import type { Browser, BrowserContext, Page } from 'playwright'
import type { BrowserOptions, BrowserStep } from '../types.js'
import type { RuntimeContext } from '../context.js'

// ---------------------------------------------------------------------------
// Browser executor -- thin Playwright wrapper
// ---------------------------------------------------------------------------

export type BrowserSession = {
  browser: Browser
  context: BrowserContext
  page: Page
}

export async function launchBrowser(options: { headed?: boolean } = {}): Promise<BrowserSession> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: !options.headed })
  const context = await browser.newContext()
  const page = await context.newPage()
  return { browser, context, page }
}

export async function closeBrowser(session: BrowserSession): Promise<void> {
  await session.browser.close()
}

export async function executeBrowserStep(
  step: BrowserStep,
  session: BrowserSession,
  ctx: RuntimeContext,
  baseUrl: string
): Promise<void> {
  const { page } = session
  const options = step as BrowserOptions

  switch (options.action) {
    case 'goto': {
      const url = String(ctx.resolveDeep(options.url))
      const fullUrl = url.startsWith('http') ? url : `${baseUrl.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`
      await page.goto(fullUrl)
      break
    }
    case 'click': {
      const target = String(ctx.resolveDeep(options.target))
      await page.locator(target).click()
      break
    }
    case 'type': {
      const target = String(ctx.resolveDeep(options.target))
      const value = String(ctx.resolveDeep(options.value))
      await page.locator(target).fill(value)
      break
    }
    case 'press': {
      const target = String(ctx.resolveDeep(options.target))
      await page.locator(target).press(options.key)
      break
    }
    case 'select': {
      const target = String(ctx.resolveDeep(options.target))
      const value = String(ctx.resolveDeep(options.value))
      await page.locator(target).selectOption(value)
      break
    }
    case 'check': {
      const target = String(ctx.resolveDeep(options.target))
      await page.locator(target).check()
      break
    }
    case 'uncheck': {
      const target = String(ctx.resolveDeep(options.target))
      await page.locator(target).uncheck()
      break
    }
    case 'waitFor': {
      if ('url' in options) {
        const url = String(ctx.resolveDeep(options.url))
        const fullPattern = url.startsWith('http') ? url : `**${url}`
        await page.waitForURL(fullPattern, {
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        })
      } else {
        const target = String(ctx.resolveDeep(options.target))
        await page.locator(target).waitFor({
          state: options.state,
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        })
      }
      break
    }
    case 'extract': {
      const target = String(ctx.resolveDeep(options.target))
      const locator = page.locator(target)
      for (const [saveName, source] of Object.entries(options.save)) {
        let value: string | null
        if (source === 'text') {
          value = await locator.textContent()
        } else if (source === 'value') {
          value = await locator.inputValue()
        } else if (source === 'html') {
          value = await locator.innerHTML()
        } else if (source.startsWith('attr:')) {
          const attrName = source.slice(5)
          value = await locator.getAttribute(attrName)
        } else {
          throw new Error(`Unknown extract source: "${source}". Use "text", "value", "html", or "attr:<name>"`)
        }
        ctx.set(saveName, value)
      }
      break
    }
    default: {
      const _exhaustive = (options as { action: string }).action
      throw new Error(`Unknown browser action: "${_exhaustive}"`)
    }
  }
}
