import type {
	PullRequestSearchCriteria,
	PullRequestSorting,
	PullRequestStateFilter,
} from '@gitlens/git/models/pullRequest.js';
import { defaultPullRequestSort, PullRequestFilter } from '@gitlens/git/models/pullRequest.js';
import { sanitizeGitHubSearchText } from './issueSearchQuery.js';

export type GitHubPullRequestSearchFacet = {
	/** Stable GraphQL alias and composite-cursor key. */
	alias: string;
	qualifiers: string[];
};

const relationshipQualifier: Record<PullRequestFilter, string> = {
	[PullRequestFilter.Author]: 'author:@me',
	[PullRequestFilter.Assignee]: 'assignee:@me',
	[PullRequestFilter.ReviewRequested]: 'review-requested:@me',
	[PullRequestFilter.Mention]: 'mentions:@me',
};

const relationshipAlias: Record<PullRequestFilter, string> = {
	[PullRequestFilter.Author]: 'author',
	[PullRequestFilter.Assignee]: 'assignee',
	[PullRequestFilter.ReviewRequested]: 'reviewRequested',
	[PullRequestFilter.Mention]: 'mention',
};

const stateAlias: Record<PullRequestStateFilter, string> = {
	open: 'Open',
	closed: 'Closed',
	merged: 'Merged',
	all: 'All',
};

/**
 * How each orderable key becomes a GitHub `sort:` qualifier.
 *
 * A literal `Record` over the union rather than a derived transform, for the same reason the relationship tables
 * are: adding a sort field without deciding its qualifier fails the build instead of quietly emitting a search
 * with no ordering constraint — the one failure mode the ordering contract exists to prevent, and the one a
 * caller cannot detect from the result.
 *
 * `updated:desc` maps to the bare `sort:updated`, not `sort:updated-desc`. The two are the same query to GitHub,
 * but the bare form is what this read has always emitted, so keeping it makes the default byte-identical to
 * today's query — matching `toGitHubIssueSortQualifier`. Do not "normalize" it.
 */
export const gitHubPullRequestSortQualifiers: Partial<Record<PullRequestSorting, string>> = {
	'created:asc': 'sort:created-asc',
	'created:desc': 'sort:created-desc',
	'updated:asc': 'sort:updated-asc',
	'updated:desc': 'sort:updated',
};

/** The `sort:` qualifier for a key, or `undefined` when there is no key or GitHub can't express it. */
export function toGitHubPullRequestSortQualifier(sort: PullRequestSorting | undefined): string | undefined {
	return sort != null ? gitHubPullRequestSortQualifiers[sort] : undefined;
}

function stateQualifiers(state: PullRequestStateFilter): string[] {
	switch (state) {
		case 'closed':
			// GitHub's `is:closed` includes merged PRs; `is:unmerged` removes that subset.
			return ['is:closed', 'is:unmerged'];
		case 'merged':
			return ['is:merged'];
		case 'all':
			return [];
		case 'open':
			return ['is:open'];
	}
}

/**
 * Translates provider-neutral PR criteria into the independent GitHub searches whose union answers the request.
 *
 * GitHub's API search syntax ANDs repeated relationship/state qualifiers and does not implement the boolean
 * groups accepted by the newer web UI. Each requested relationship × state pair therefore becomes one GraphQL
 * alias; the API client sends every active alias in a single document, preserving one HTTP request per page.
 * An omitted relationship is the explicitly unfiltered repository/organization scope, never `involves:@me`.
 */
export function toGitHubPullRequestSearchFacets(
	criteria: PullRequestSearchCriteria | undefined,
): GitHubPullRequestSearchFacet[] {
	const relationships: (PullRequestFilter | undefined)[] = criteria?.relationships?.length
		? [...new Set(criteria.relationships)]
		: [undefined];
	const requestedStates: PullRequestStateFilter[] = criteria?.states?.length
		? [...new Set(criteria.states)]
		: ['open'];
	const states: PullRequestStateFilter[] = requestedStates.includes('all') ? ['all'] : requestedStates;
	const text = criteria?.text != null ? sanitizeGitHubSearchText(criteria.text) : '';
	// Ordering is part of the contract, not an option: without an explicit `sort:` GitHub answers in relevance
	// order, so which rows land inside the result ceiling would shift with its ranking even when nothing changed
	// upstream. The key is validated against `githubPullRequestSearchCapabilities.sorts` before it reaches here,
	// so it always maps; the fallback only keeps the type a string and byte-identical to the historical default.
	const sortQualifier = toGitHubPullRequestSortQualifier(criteria?.sort ?? defaultPullRequestSort) ?? 'sort:updated';

	return relationships.flatMap(relationship =>
		states.map(state => ({
			alias: `${relationship != null ? relationshipAlias[relationship] : 'scope'}${stateAlias[state]}`,
			qualifiers: [
				'is:pr',
				...(relationship != null ? [relationshipQualifier[relationship]] : []),
				...stateQualifiers(state),
				...(criteria?.includeArchived === true ? [] : ['archived:false']),
				...(text.length > 0 ? [text] : []),
				sortQualifier,
			],
		})),
	);
}
