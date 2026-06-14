<?php
/**
 * REST API surface for DBP WP Connector.
 *
 * @package DBP_WP_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Registers the connector's REST API surface.
 *
 * WordPress core only exposes post meta that was registered with `show_in_rest`,
 * so the DBP WP app cannot read or edit arbitrary custom fields through core
 * routes alone. This connector closes that gap and nothing more:
 *
 * - A `dbp_wp_meta` field on every REST-enabled post type, readable and writable
 *   in the `edit` context, rides the existing `/wp/v2/<type>/<id>` routes the app
 *   already uses. Reads return every meta key; writes upsert the provided keys.
 * - A `DELETE /dbp-wp/v1/posts/<id>/meta` route deletes named meta keys on a
 *   single post (there is no core equivalent).
 *
 * The connector adds no authentication. Requests authenticate with WordPress core
 * Application Passwords, and every operation is gated by the same `edit_post`
 * capability check WordPress applies when editing the target post.
 */
class DBP_WP_Connector_REST {

	/**
	 * REST namespace for the connector's custom routes.
	 *
	 * @var string
	 */
	const REST_NAMESPACE = 'dbp-wp/v1';

	/**
	 * Name of the post-meta field added to REST-enabled post types.
	 *
	 * @var string
	 */
	const META_FIELD = 'dbp_wp_meta';

	/**
	 * Hook the connector's registration callbacks onto `rest_api_init`.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'rest_api_init', array( $this, 'register_meta_field' ) );
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * Expose a `dbp_wp_meta` field on every REST-enabled post type.
	 *
	 * The field appears only in the `edit` context, which already requires edit
	 * capabilities, so the field is never part of an anonymous/public response.
	 *
	 * @return void
	 */
	public function register_meta_field() {
		$post_types = get_post_types( array( 'show_in_rest' => true ), 'names' );
		foreach ( $post_types as $post_type ) {
			register_rest_field(
				$post_type,
				self::META_FIELD,
				array(
					'get_callback'    => array( $this, 'get_meta' ),
					'update_callback' => array( $this, 'update_meta' ),
					'schema'          => array(
						'description' => __( 'Arbitrary post meta exposed by DBP WP Connector.', 'dbp-wp-connector' ),
						'type'        => 'object',
						'context'     => array( 'edit' ),
					),
				)
			);
		}
	}

	/**
	 * Read every meta key for a post as a flat `{ key: value }` map.
	 *
	 * `get_post_meta()` returns each key as an array of raw (possibly serialized)
	 * values; this exposes the first value per key, unserialized. Multi-value meta
	 * keys are out of scope for the MVP and only the first value is returned.
	 *
	 * @param array $post_arr Prepared post response data (contains the post `id`).
	 * @return array<string, mixed> Map of meta key to single value.
	 */
	public function get_meta( $post_arr ) {
		$post_id = isset( $post_arr['id'] ) ? (int) $post_arr['id'] : 0;
		if ( $post_id <= 0 ) {
			return array();
		}

		$raw    = get_post_meta( $post_id );
		$result = array();
		foreach ( $raw as $key => $values ) {
			$first          = ( is_array( $values ) && array() !== $values ) ? reset( $values ) : '';
			$result[ $key ] = maybe_unserialize( $first );
		}

		return $result;
	}

	/**
	 * Upsert the supplied meta keys when a post is written with `dbp_wp_meta`.
	 *
	 * Only scalar values are written (the MVP edits flat custom fields); non-scalar
	 * values are skipped. The capability check is defensive: core already gated the
	 * surrounding post update, but the connector re-checks before touching meta.
	 *
	 * @param mixed   $value      Submitted field value (expected: associative array).
	 * @param WP_Post $post       The post being updated.
	 * @param string  $field_name The REST field name (unused).
	 * @return WP_Error|void Error when the caller cannot edit the post; otherwise void.
	 */
	public function update_meta( $value, $post, $field_name ) {
		unset( $field_name );

		if ( ! is_array( $value ) ) {
			return; // Nothing to write for a non-object payload.
		}

		if ( ! current_user_can( 'edit_post', $post->ID ) ) {
			return new WP_Error(
				'dbp_wp_connector_forbidden',
				__( 'You are not allowed to edit meta on this post.', 'dbp-wp-connector' ),
				array( 'status' => rest_authorization_required_code() )
			);
		}

		foreach ( $value as $key => $meta_value ) {
			if ( ! is_string( $key ) || '' === $key ) {
				continue;
			}
			if ( null !== $meta_value && ! is_scalar( $meta_value ) ) {
				continue; // MVP writes scalar meta values only.
			}
			// WordPress meta functions unslash their arguments internally, so REST-
			// decoded (already-unslashed) strings must be re-slashed to survive intact.
			$slashed_value = is_string( $meta_value ) ? wp_slash( $meta_value ) : $meta_value;
			update_post_meta( $post->ID, wp_slash( $key ), $slashed_value );
		}
	}

	/**
	 * Register the custom delete-by-key route.
	 *
	 * @return void
	 */
	public function register_routes() {
		register_rest_route(
			self::REST_NAMESPACE,
			'/posts/(?P<id>\d+)/meta',
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => array( $this, 'delete_meta' ),
				'permission_callback' => array( $this, 'can_edit_post' ),
				'args'                => array(
					'id'   => array(
						'validate_callback' => static function ( $param ) {
							return is_numeric( $param ) && (int) $param > 0;
						},
					),
					'keys' => array(
						'required' => true,
						'type'     => 'array',
						'items'    => array( 'type' => 'string' ),
					),
				),
			)
		);
	}

	/**
	 * Permission check for the delete route: the caller must be able to edit the post.
	 *
	 * @param WP_REST_Request $request The incoming request.
	 * @return true|WP_Error True when allowed; otherwise an error with a 4xx status.
	 */
	public function can_edit_post( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		$post    = get_post( $post_id );
		if ( null === $post ) {
			return new WP_Error(
				'dbp_wp_connector_not_found',
				__( 'Post not found.', 'dbp-wp-connector' ),
				array( 'status' => 404 )
			);
		}
		if ( wp_is_post_revision( $post_id ) ) {
			return new WP_Error(
				'dbp_wp_connector_invalid',
				__( 'Meta deletion must target a post, not a revision or autosave.', 'dbp-wp-connector' ),
				array( 'status' => 400 )
			);
		}
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			return new WP_Error(
				'dbp_wp_connector_forbidden',
				__( 'You are not allowed to edit this post.', 'dbp-wp-connector' ),
				array( 'status' => rest_authorization_required_code() )
			);
		}
		return true;
	}

	/**
	 * Delete the named meta keys from a single post.
	 *
	 * Deletion is scoped to one post: `delete_post_meta()` removes every value of a
	 * key on that post only. The connector deliberately does not offer the legacy
	 * site-wide delete-by-key behaviour, which removed a key across all posts.
	 *
	 * @param WP_REST_Request $request The incoming request.
	 * @return WP_REST_Response|WP_Error Response listing deleted keys, or an error.
	 */
	public function delete_meta( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		$keys    = $request->get_param( 'keys' );
		if ( ! is_array( $keys ) ) {
			return new WP_Error(
				'dbp_wp_connector_invalid',
				__( 'The "keys" parameter must be an array of meta keys.', 'dbp-wp-connector' ),
				array( 'status' => 400 )
			);
		}

		$deleted = array();
		foreach ( $keys as $key ) {
			if ( ! is_string( $key ) || '' === $key ) {
				continue;
			}
			// Re-slash the key: delete_post_meta() unslashes it internally before matching.
			if ( delete_post_meta( $post_id, wp_slash( $key ) ) ) {
				$deleted[] = $key;
			}
		}

		return rest_ensure_response(
			array(
				'post_id' => $post_id,
				'deleted' => $deleted,
			)
		);
	}
}
