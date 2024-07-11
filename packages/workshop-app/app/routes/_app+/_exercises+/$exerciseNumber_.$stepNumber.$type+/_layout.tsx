import { ElementScrollRestoration } from '@epic-web/restore-scroll'
import {
	getAppByName,
	getAppDisplayName,
	getAppPageRoute,
	getApps,
	getExerciseApp,
	getNextExerciseApp,
	getPrevExerciseApp,
	getWorkshopTitle,
	isExerciseStepApp,
	isPlaygroundApp,
	requireExercise,
	requireExerciseApp,
	type App,
	type ExerciseStepApp,
} from '@epic-web/workshop-utils/apps.server'
import {
	isAppRunning,
	isPortAvailable,
} from '@epic-web/workshop-utils/process-manager.server'
import {
	combineServerTimings,
	getServerTimeHeader,
	makeTimings,
} from '@epic-web/workshop-utils/timing.server'
import * as Tabs from '@radix-ui/react-tabs'
import {
	defer,
	redirect,
	type HeadersFunction,
	type LoaderFunctionArgs,
	type MetaFunction,
	type SerializeFrom,
} from '@remix-run/node'
import {
	Link,
	useLoaderData,
	useNavigate,
	useSearchParams,
} from '@remix-run/react'
import slugify from '@sindresorhus/slugify'
import { clsx } from 'clsx'
import * as React from 'react'
import { useRef } from 'react'
import { Diff } from '#app/components/diff.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { type InBrowserBrowserRef } from '#app/components/in-browser-browser.tsx'
import { NavChevrons } from '#app/components/nav-chevrons.tsx'
import { type loader as rootLoader } from '#app/root.tsx'
import { getDiscordAuthURL } from '#app/routes/discord.callback.ts'
import { EditFileOnGitHub } from '#app/routes/launch-editor.tsx'
import { ProgressToggle } from '#app/routes/progress.tsx'
import { SetAppToPlayground } from '#app/routes/set-playground.tsx'
import { getDiffCode, getDiffFiles } from '#app/utils/diff.server.ts'
import { getEpicVideoInfos } from '#app/utils/epic-api.ts'
import { useAltDown } from '#app/utils/misc.tsx'
import { getSeoMetaTags } from '#app/utils/seo.js'
import { fetchDiscordPosts } from './__shared/discord.server.ts'
import { DiscordChat } from './__shared/discord.tsx'
import { Playground } from './__shared/playground.tsx'
import { Preview } from './__shared/preview.tsx'
import { StepMdx } from './__shared/step-mdx.tsx'
import { Tests } from './__shared/tests.tsx'
import TouchedFiles from './__shared/touched-files.tsx'

function pageTitle(
	data: SerializeFrom<typeof loader> | undefined,
	workshopTitle?: string,
) {
	const exerciseNumber =
		data?.exerciseStepApp.exerciseNumber.toString().padStart(2, '0') ?? '00'
	const stepNumber =
		data?.exerciseStepApp.stepNumber.toString().padStart(2, '0') ?? '00'
	const emoji = (
		{
			problem: '💪',
			solution: '🏁',
		} as const
	)[data?.type ?? 'problem']
	const title = data?.[data.type]?.title ?? 'N/A'
	return {
		emoji,
		stepNumber,
		title,
		exerciseNumber,
		exerciseTitle: data?.exerciseTitle ?? 'Unknown exercise',
		workshopTitle,
		type: data?.type ?? 'problem',
	}
}

export const meta: MetaFunction<typeof loader, { root: typeof rootLoader }> = ({
	data,
	matches,
	params,
}) => {
	const rootData = matches.find((m) => m.id === 'root')?.data
	if (!data || !rootData) return [{ title: '🦉 | Error' }]
	const { emoji, stepNumber, title, exerciseNumber, exerciseTitle } =
		pageTitle(data)

	return getSeoMetaTags({
		title: `${emoji} | ${stepNumber}. ${title} | ${exerciseNumber}. ${exerciseTitle} | ${rootData.workshopTitle}`,
		description: `${params.type} step for exercise ${exerciseNumber}. ${exerciseTitle}`,
		ogTitle: title,
		ogDescription: `${exerciseTitle} step ${Number(stepNumber)} ${params.type}`,
		instructor: rootData.instructor,
		requestInfo: rootData.requestInfo,
	})
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const timings = makeTimings('exerciseStepTypeLoader')
	const workshopTitle = await getWorkshopTitle()
	const searchParams = new URL(request.url).searchParams
	const cacheOptions = { request, timings }
	const exerciseStepApp = await requireExerciseApp(params, cacheOptions)
	const exercise = await requireExercise(
		exerciseStepApp.exerciseNumber,
		cacheOptions,
	)
	const reqUrl = new URL(request.url)

	const pathnameParam = reqUrl.searchParams.get('pathname')
	if (pathnameParam === '' || pathnameParam === '/') {
		reqUrl.searchParams.delete('pathname')
		throw redirect(reqUrl.toString())
	}

	const problemApp = await getExerciseApp(
		{ ...params, type: 'problem' },
		cacheOptions,
	)
	const solutionApp = await getExerciseApp(
		{ ...params, type: 'solution' },
		cacheOptions,
	)

	if (!problemApp && !solutionApp) {
		throw new Response('Not found', { status: 404 })
	}

	const allAppsFull = await getApps(cacheOptions)
	const playgroundApp = allAppsFull.find(isPlaygroundApp)

	const app1Name = reqUrl.searchParams.get('app1')
	const app2Name = reqUrl.searchParams.get('app2')
	const app1 = app1Name
		? await getAppByName(app1Name)
		: playgroundApp || problemApp
	const app2 = app2Name ? await getAppByName(app2Name) : solutionApp

	function getStepId(a: ExerciseStepApp) {
		return (
			a.exerciseNumber * 1000 +
			a.stepNumber * 10 +
			(a.type === 'problem' ? 0 : 1)
		)
	}

	function getStepNameAndId(a: App) {
		if (isExerciseStepApp(a)) {
			const exerciseNumberStr = String(a.exerciseNumber).padStart(2, '0')
			const stepNumberStr = String(a.stepNumber).padStart(2, '0')

			return {
				stepName: `${exerciseNumberStr}/${stepNumberStr}.${a.type}`,
				stepId: getStepId(a),
			}
		}
		return { stepName: '', stepId: -1 }
	}

	async function getAppRunningState(a: App) {
		if (a.dev.type !== 'script') {
			return { isRunning: false, portIsAvailable: null }
		}
		const isRunning = isAppRunning(a)
		const portIsAvailable = isRunning
			? null
			: await isPortAvailable(a.dev.portNumber)
		return { isRunning, portIsAvailable }
	}

	const allApps = allAppsFull
		.filter((a, i, ar) => ar.findIndex((b) => a.name === b.name) === i)
		.map((a) => ({
			displayName: getAppDisplayName(a, allAppsFull),
			name: a.name,
			title: a.title,
			type: a.type,
			...getStepNameAndId(a),
		}))

	allApps.sort((a, b) => {
		// order them by their stepId
		if (a.stepId > 0 && b.stepId > 0) return a.stepId - b.stepId

		// non-step apps should come after step apps
		if (a.stepId > 0) return -1
		if (b.stepId > 0) return 1

		return 0
	})
	const exerciseId = getStepId(exerciseStepApp)
	const exerciseIndex = allApps.findIndex((step) => step.stepId === exerciseId)

	const exerciseApps = allAppsFull
		.filter(isExerciseStepApp)
		.filter((app) => app.exerciseNumber === exerciseStepApp.exerciseNumber)
	const isLastStep =
		exerciseApps[exerciseApps.length - 1]?.name === exerciseStepApp.name
	const isFirstStep = exerciseApps[0]?.name === exerciseStepApp.name

	const nextApp = await getNextExerciseApp(exerciseStepApp, cacheOptions)
	const prevApp = await getPrevExerciseApp(exerciseStepApp, cacheOptions)

	async function getDiffProp() {
		if (!app1 || !app2) {
			return {
				app1: app1?.name,
				app2: app2?.name,
				diffCode: null,
				diffFiles: null,
			}
		}
		const [diffCode, diffFiles] = await Promise.all([
			getDiffCode(app1, app2, {
				...cacheOptions,
				forceFresh: searchParams.get('forceFresh') === 'diff',
			}).catch((e) => {
				console.error(e)
				return null
			}),
			problemApp && solutionApp
				? getDiffFiles(problemApp, solutionApp, {
						...cacheOptions,
						forceFresh: searchParams.get('forceFresh') === 'diff',
					}).catch((e) => {
						console.error(e)
						return 'There was a problem generating the diff'
					})
				: 'No diff available',
		])
		return {
			app1: app1.name,
			app2: app2.name,
			diffCode,
			diffFiles,
		}
	}

	const articleId = `workshop-${slugify(workshopTitle)}-${
		exercise.exerciseNumber
	}-${exerciseStepApp.stepNumber}-${exerciseStepApp.type}`
	return defer(
		{
			articleId,
			type: params.type as 'problem' | 'solution',
			exerciseStepApp,
			exerciseTitle: exercise.title,
			epicVideoInfosPromise: getEpicVideoInfos(exerciseStepApp.epicVideoEmbeds),
			exerciseIndex,
			allApps,
			discordAuthUrl: getDiscordAuthURL(),
			// defer this promise so that we don't block the response from being sent
			discordPostsPromise: fetchDiscordPosts({ request }),
			prevStepLink: isFirstStep
				? {
						to: `/${exerciseStepApp.exerciseNumber
							.toString()
							.padStart(2, '0')}`,
					}
				: prevApp
					? { to: getAppPageRoute(prevApp) }
					: null,
			nextStepLink: isLastStep
				? {
						to: `/${exerciseStepApp.exerciseNumber
							.toString()
							.padStart(2, '0')}/finished`,
					}
				: nextApp
					? { to: getAppPageRoute(nextApp) }
					: null,
			playground: playgroundApp
				? ({
						type: 'playground',
						fullPath: playgroundApp.fullPath,
						dev: playgroundApp.dev,
						test: playgroundApp.test,
						title: playgroundApp.title,
						name: playgroundApp.name,
						appName: playgroundApp.appName,
						isUpToDate: playgroundApp.isUpToDate,
						stackBlitzUrl: playgroundApp.stackBlitzUrl,
						...(await getAppRunningState(playgroundApp)),
					} as const)
				: null,
			problem: problemApp
				? ({
						type: 'problem',
						fullPath: problemApp.fullPath,
						dev: problemApp.dev,
						test: problemApp.test,
						title: problemApp.title,
						name: problemApp.name,
						stackBlitzUrl: problemApp.stackBlitzUrl,
						...(await getAppRunningState(problemApp)),
					} as const)
				: null,
			solution: solutionApp
				? ({
						type: 'solution',
						fullPath: solutionApp.fullPath,
						dev: solutionApp.dev,
						test: solutionApp.test,
						title: solutionApp.title,
						name: solutionApp.name,
						stackBlitzUrl: solutionApp.stackBlitzUrl,
						...(await getAppRunningState(solutionApp)),
					} as const)
				: null,
			diff: getDiffProp(),
		} as const,
		{
			headers: {
				'Server-Timing': getServerTimeHeader(timings),
			},
		},
	)
}

export const headers: HeadersFunction = ({ loaderHeaders, parentHeaders }) => {
	const headers = {
		'Server-Timing': combineServerTimings(loaderHeaders, parentHeaders),
	}
	return headers
}

const tabs = [
	'playground',
	'problem',
	'solution',
	'tests',
	'diff',
	'chat',
] as const
const isValidPreview = (s: string | null): s is (typeof tabs)[number] =>
	Boolean(s && tabs.includes(s as (typeof tabs)[number]))

function withParam(
	searchParams: URLSearchParams,
	key: string,
	value: string | null,
) {
	const newSearchParams = new URLSearchParams(searchParams)
	if (value === null) {
		newSearchParams.delete(key)
	} else {
		newSearchParams.set(key, value)
	}
	return newSearchParams
}

export default function ExercisePartRoute() {
	const data = useLoaderData<typeof loader>()
	const [searchParams] = useSearchParams()

	const preview = searchParams.get('preview')
	const inBrowserBrowserRef = useRef<InBrowserBrowserRef>(null)

	const titleBits = pageTitle(data)
	const altDown = useAltDown()
	const navigate = useNavigate()

	function shouldHideTab(tab: (typeof tabs)[number]) {
		if (tab === 'tests') {
			return (
				ENV.EPICSHOP_DEPLOYED ||
				!data.playground ||
				data.playground.test.type === 'none'
			)
		}
		if (tab === 'problem' || tab === 'solution') {
			if (data[tab]?.dev.type === 'none') return true
			if (ENV.EPICSHOP_DEPLOYED) {
				return data[tab]?.dev.type !== 'browser' && !data[tab]?.stackBlitzUrl
			}
		}
		if (tab === 'playground' && ENV.EPICSHOP_DEPLOYED) return true
		return false
	}

	const activeTab = isValidPreview(preview)
		? preview
		: tabs.find((t) => !shouldHideTab(t))

	// when alt is held down, the diff tab should open to the full-page diff view
	// between the problem and solution (this is more for the instructor than the student)
	const altDiffUrl = `/diff?${new URLSearchParams({
		app1: data.problem?.name ?? '',
		app2: data.solution?.name ?? '',
	})}`

	function handleDiffTabClick(event: React.MouseEvent<HTMLAnchorElement>) {
		if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
			event.preventDefault()
			navigate(altDiffUrl)
		}
	}

	return (
		<div className="flex max-w-full flex-grow flex-col">
			<main className="flex flex-grow flex-col sm:grid sm:h-full sm:min-h-[800px] sm:grid-cols-1 sm:grid-rows-2 md:min-h-[unset] lg:grid-cols-2 lg:grid-rows-1">
				<div className="relative flex flex-col sm:col-span-1 sm:row-span-1 sm:h-full lg:border-r">
					<h1 className="h-14 border-b pl-10 pr-5 text-sm font-medium leading-tight">
						<div className="flex h-14 flex-wrap items-center justify-between gap-x-2 py-2">
							<div className="flex items-center justify-start gap-x-2 uppercase">
								<Link
									to={`/${titleBits.exerciseNumber}`}
									className="hover:underline"
								>
									{titleBits.exerciseNumber}. {titleBits.exerciseTitle}
								</Link>
								{'/'}
								<Link to="." className="hover:underline">
									{titleBits.stepNumber}. {titleBits.title}
									{' ('}
									{titleBits.emoji} {titleBits.type}
									{')'}
								</Link>
							</div>
							{data.problem &&
							data.playground?.appName !== data.problem.name ? (
								<div className="hidden md:block">
									<SetAppToPlayground appName={data.problem.name} />
								</div>
							) : null}
						</div>
					</h1>
					<article
						id={data.articleId}
						key={data.articleId}
						className="shadow-on-scrollbox h-full w-full max-w-none flex-1 scroll-pt-6 space-y-6 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-scrollbar sm:p-10 sm:pt-8"
					>
						{data.exerciseStepApp.instructionsCode ? (
							<StepMdx inBrowserBrowserRef={inBrowserBrowserRef} />
						) : (
							<p>No instructions yet...</p>
						)}
					</article>
					<ElementScrollRestoration
						elementQuery={`#${data.articleId}`}
						key={`scroll-${data.articleId}`}
					/>
					{data.type === 'solution' ? (
						<ProgressToggle
							type="step"
							exerciseNumber={data.exerciseStepApp.exerciseNumber}
							stepNumber={data.exerciseStepApp.stepNumber}
							className="h-14 border-t px-6"
						/>
					) : null}
					<div className="flex h-16 justify-between border-b-4 border-t lg:border-b-0">
						<div>
							<div className="h-full">
								<TouchedFiles />
							</div>
						</div>
						<EditFileOnGitHub
							appName={data.exerciseStepApp.name}
							relativePath={data.exerciseStepApp.relativePath}
						/>
						<NavChevrons
							prev={
								data.prevStepLink
									? {
											to: data.prevStepLink.to,
											'aria-label': 'Previous Step',
										}
									: null
							}
							next={
								data.nextStepLink
									? {
											to: data.nextStepLink.to,
											'aria-label': 'Next Step',
										}
									: null
							}
						/>
					</div>
				</div>
				<Tabs.Root
					className="relative flex flex-col overflow-y-auto sm:col-span-1 sm:row-span-1"
					value={activeTab}
					// intentionally no onValueChange here because the Link will trigger the
					// change.
				>
					<Tabs.List className="h-14 min-h-14 overflow-x-hidden border-b scrollbar-thin scrollbar-thumb-scrollbar">
						{tabs.map((tab) => {
							const hidden = shouldHideTab(tab)
							return (
								<Tabs.Trigger key={tab} value={tab} hidden={hidden} asChild>
									<Link
										id={`${tab}-tab`}
										className={clsx(
											'clip-path-button relative h-full px-6 py-4 font-mono text-sm uppercase outline-none radix-state-active:z-10 radix-state-active:bg-foreground radix-state-active:text-background radix-state-active:hover:bg-foreground/80 radix-state-active:hover:text-background/80 radix-state-inactive:hover:bg-foreground/20 radix-state-inactive:hover:text-foreground/80 focus:bg-foreground/80 focus:text-background/80',
											hidden ? 'hidden' : 'inline-block',
										)}
										preventScrollReset
										prefetch="intent"
										onClick={handleDiffTabClick}
										to={
											tab === 'diff' && altDown
												? altDiffUrl
												: `?${withParam(
														searchParams,
														'preview',
														tab === 'playground' ? null : tab,
													)}`
										}
									>
										{tab}
									</Link>
								</Tabs.Trigger>
							)
						})}
					</Tabs.List>
					<div className="relative z-10 flex min-h-96 flex-grow flex-col overflow-y-auto">
						<Tabs.Content
							value="playground"
							className="flex w-full flex-grow items-center justify-center self-start radix-state-inactive:hidden"
						>
							<Playground
								appInfo={data.playground}
								problemAppName={data.problem?.name}
								inBrowserBrowserRef={inBrowserBrowserRef}
								allApps={data.allApps}
								isUpToDate={data.playground?.isUpToDate ?? false}
							/>
						</Tabs.Content>
						<Tabs.Content
							value="problem"
							className="flex w-full flex-grow items-center justify-center self-start radix-state-inactive:hidden"
						>
							<Preview
								appInfo={data.problem}
								inBrowserBrowserRef={inBrowserBrowserRef}
							/>
						</Tabs.Content>
						<Tabs.Content
							value="solution"
							className="flex w-full flex-grow items-center justify-center self-start radix-state-inactive:hidden"
						>
							<Preview
								appInfo={data.solution}
								inBrowserBrowserRef={inBrowserBrowserRef}
							/>
						</Tabs.Content>
						<Tabs.Content
							value="tests"
							className="flex w-full flex-grow items-start justify-center self-start overflow-hidden radix-state-inactive:hidden"
						>
							<Tests
								appInfo={data.playground}
								problemAppName={data.problem?.name}
								allApps={data.allApps}
								isUpToDate={data.playground?.isUpToDate ?? false}
							/>
						</Tabs.Content>
						<Tabs.Content
							value="diff"
							className="flex h-full w-full flex-grow items-start justify-center self-start radix-state-inactive:hidden"
						>
							<Diff diff={data.diff} allApps={data.allApps} />
						</Tabs.Content>
						<Tabs.Content
							value="chat"
							className="flex h-full w-full flex-grow items-start justify-center self-start radix-state-inactive:hidden"
						>
							<DiscordChat />
						</Tabs.Content>
					</div>
				</Tabs.Root>
			</main>
		</div>
	)
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				404: () => <p>Sorry, we couldn't find an app here.</p>,
			}}
		/>
	)
}
