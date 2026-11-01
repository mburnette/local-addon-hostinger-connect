'use strict';

const path = require('path');

const createComponents = require('./renderer/components');

const NEW_SITE_ROUTE = '/main/hostinger-pull';

module.exports = function HostingerConnectRenderer(context) {
	const { React, ReactRouter, hooks } = context;
	const h = React.createElement;
	const { HostingerPanel, HeaderButtons, NewSitePage } = createComponents(context);

	hooks.addContent('stylesheets', () => h('link', {
		key: 'hostinger-connect-styles',
		rel: 'stylesheet',
		href: path.join(__dirname, 'renderer', 'styles.css'),
	}));

	// A "Hostinger" entry under the site's Tools tab: account connection, linking, and push/pull options.
	hooks.addFilter('siteInfoToolsItem', (items, { routeChildrenProps } = {}) => [
		...items,
		{
			path: '/hostinger-connect',
			menuItem: 'Hostinger',
			render: () => h(HostingerPanel, {
				site: routeChildrenProps && routeChildrenProps.site,
				siteStatus: routeChildrenProps && routeChildrenProps.siteStatus,
			}),
		},
	]);

	// "Hostinger: Pull / Push" buttons in the site header, next to Local Connect's own push/pull buttons.
	hooks.addContent('SiteInfo_Top_TopRight', (site, siteStatus) => h(HeaderButtons, {
		key: 'hostinger-connect-buttons',
		site,
		siteStatus,
	}));

	// "Pull from Hostinger" in Local's Create a site wizard. The option key is the route Continue navigates to.
	hooks.addFilter('CreateSite:RadioOptions', (options) => ({
		...options,
		[NEW_SITE_ROUTE.replace(/^\/main\//, '')]: {
			label: 'Pull from Hostinger',
			content: 'Create a new Local site from a Hostinger WordPress website, files and database.',
		},
	}));

	hooks.addContent('routes[main]', () => h(ReactRouter.Route, {
		key: 'hostinger-connect-new-site',
		path: NEW_SITE_ROUTE,
		render: ({ history }) => h(NewSitePage, { history }),
	}));
};
