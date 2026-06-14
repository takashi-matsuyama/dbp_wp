<?php
/**
 * Plugin Name:       DBP WP Connector
 * Plugin URI:        https://github.com/takashi-matsuyama/dbp_wp
 * Description:       Optional companion for the DBP WP app: exposes arbitrary post meta over the REST API (read/write) and per-post meta deletion by key. Authentication is delegated entirely to WordPress core Application Passwords and capability checks; the plugin adds no authentication of its own.
 * Version:           0.1.0
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            caronima
 * Author URI:        https://github.com/takashi-matsuyama
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       dbp-wp-connector
 *
 * @package DBP_WP_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

require_once __DIR__ . '/includes/class-dbp-wp-connector-rest.php';

/**
 * Boot the connector's REST surface once WordPress is ready.
 *
 * The constructor only stores state; route and field registration happen on the
 * `rest_api_init` hook, so loading the plugin has no effect outside REST requests.
 */
add_action(
	'plugins_loaded',
	static function () {
		( new DBP_WP_Connector_REST() )->register();
	}
);
