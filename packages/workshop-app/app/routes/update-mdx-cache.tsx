import fs from 'node:fs'
import { setModifiedTimesForDir } from '@epic-web/workshop-utils/apps.server'
import { type EmbeddedFile } from '@epic-web/workshop-utils/codefile-mdx.server'
import { json, type ActionFunctionArgs } from '@remix-run/node'
import { useFetcher } from '@remix-run/react'
import { clsx } from 'clsx'
import { z } from 'zod'
import { showProgressBarField } from '#app/components/progress-bar.tsx'
import { ensureUndeployed } from '#app/utils/misc.tsx'
import { jsonWithPE, usePERedirectInput } from '#app/utils/pe.js'

const cacheSchema = z.object({
	cacheLocation: z.string(),
	embeddedKey: z.string(),
	appFullPath: z.string(),
})

function checkFileExists(file: string) {
	return fs.promises.access(file, fs.constants.F_OK).then(
		() => true,
		() => false,
	)
}

export async function action({ request }: ActionFunctionArgs) {
	ensureUndeployed()
	const formData = await request.formData()
	const rawData = {
		cacheLocation: formData.get('cacheLocation'),
		embeddedKey: formData.get('embeddedKey'),
		appFullPath: formData.get('appFullPath'),
	}

	const { cacheLocation, embeddedKey, appFullPath } = cacheSchema.parse(rawData)

	if (!(await checkFileExists(cacheLocation))) {
		console.log(`file ${cacheLocation} not found`)
		return json({ success: true })
	}

	const cached = JSON.parse(
		await fs.promises.readFile(cacheLocation, 'utf-8'),
	) as any

	const cachedEmbeddedFiles = new Map<string, EmbeddedFile>(
		Object.entries(cached?.value?.embeddedFiles ?? {}),
	)

	if (cachedEmbeddedFiles.has(embeddedKey)) {
		delete cachedEmbeddedFiles.get(embeddedKey)?.warning

		cached.value.embeddedFiles = Object.fromEntries(cachedEmbeddedFiles)
	}

	try {
		cached.value.warningCancled = true
		await fs.promises.writeFile(cacheLocation, JSON.stringify(cached))
	} catch (error) {
		console.log(
			`Error when trying to write cache file at ${cacheLocation}`,
			error,
		)
	}
	setModifiedTimesForDir(appFullPath)

	return jsonWithPE(formData, { success: true })
}

export function UpdateMdxCache({
	handleClick,
	cacheLocation,
	embeddedKey,
	appFullPath,
}: {
	handleClick: () => void
	cacheLocation: string
	embeddedKey: string
	appFullPath: string
}) {
	const fetcher = useFetcher<typeof action>()
	const peRedirectInput = usePERedirectInput()

	return (
		<fetcher.Form action="/update-mdx-cache" method="POST">
			{peRedirectInput}
			{showProgressBarField}
			<input type="hidden" name="cacheLocation" value={cacheLocation} />
			<input type="hidden" name="embeddedKey" value={embeddedKey} />
			<input type="hidden" name="appFullPath" value={appFullPath} />
			<button
				type="submit"
				onClick={handleClick}
				className={clsx(
					'launch_button',
					fetcher.state === 'idle' ? null : 'cursor-progress',
				)}
			>
				Cancel Warning
			</button>
		</fetcher.Form>
	)
}
