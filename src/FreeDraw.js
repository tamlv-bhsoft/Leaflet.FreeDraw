import 'core-js';
import 'regenerator-runtime/runtime';

import { noConflict, FeatureGroup, Point, DomEvent } from 'leaflet';
import { select } from 'd3-selection';
import { line, curveMonotoneX } from 'd3-shape';
import Set from 'es6-set';
import WeakMap from 'es6-weak-map';
import Symbol from 'es6-symbol';
import { updateFor } from './helpers/Layer';
import { createFor, removeFor, clearFor } from './helpers/Polygon';
import { CREATE, EDIT, DELETE, APPEND, EDIT_APPEND, NONE, ALL, modeFor } from './helpers/Flags';
import simplifyPolygon from './helpers/Simplify';

// Preventing binding to the `window`.
noConflict();

/**
 * @constant polygons
 * @type {WeakMap}
 */
export const polygons = new WeakMap();

/**
 * @constant defaultOptions
 * @type {Object}
 */
export const defaultOptions = {
    mode: ALL,
    smoothFactor: 0.3,
    elbowDistance: 10,
    simplifyFactor: 1.1,
    mergePolygons: true,
    concavePolygon: true,
    maximumPolygons: Infinity,
    notifyAfterEditExit: false,
    leaveModeAfterCreate: false,
    strokeWidth: 2
};

/**
 * @constant instanceKey
 * @type {Symbol}
 */
export const instanceKey = Symbol('freedraw/instance');

/**
 * @constant modesKey
 * @type {Symbol}
 */
export const modesKey = Symbol('freedraw/modes');

/**
 * @constant notifyDeferredKey
 * @type {Symbol}
 */
export const notifyDeferredKey = Symbol('freedraw/notify-deferred');

/**
 * @constant edgesKey
 * @type {Symbol}
 */
export const edgesKey = Symbol('freedraw/edges');

/**
 * @constant cancelKey
 * @type {Symbol}
 */
const cancelKey = Symbol('freedraw/cancel');

export default class FreeDraw extends FeatureGroup {

    /**
     * @constructor
     * @param {Object} [options = {}]
     * @return {void}
     */
    constructor(options = defaultOptions) {
        super();
        this.options = { ...defaultOptions, ...options };
        this.mouseDownHandler = undefined;
    }

    /**
     * @method onAdd
     * @param {Object} map
     * @return {void}
     */
    onAdd(map) {

        // Memorise the map instance.
        this.map = map;
        map._container.style['-webkit-user-select'] = 'none';

        // Attach the cancel function and the instance to the map.
        map[cancelKey] = () => {};
        map[instanceKey] = this;
        map[notifyDeferredKey] = () => {};

        // Setup the dependency injection for simplifying the polygon.
        map.simplifyPolygon = simplifyPolygon;

        // Add the item to the map.
        polygons.set(map, new Set());

        // Set the initial mode.
        modeFor(map, this.options.mode, this.options);

        // Instantiate the SVG layer that sits on top of the map.
        const svg = this.svg = select(map._container).append('svg')
                                 .classed('free-draw', true).attr('width', '100%').attr('height', '100%')
                                 .style('pointer-events', 'none').style('z-index', '1001').style('position', 'relative');

        // Set the mouse events.
        this.listenForEvents(map, svg, this.options);

    }

    /**
     * @method onRemove
     * @param {Object} map
     * @return {void}
     */
    onRemove(map) {

        // Remove the item from the map.
        polygons.delete(map);

        // Remove the SVG layer.
        this.svg.remove();

        // Remove the appendages from the map container.
        delete map[cancelKey];
        delete map[instanceKey];
        delete map.simplifyPolygon;


        if (!!this.mouseDownHandler) {
            map.off('mousedown', this.mouseDownHandler);
            map.off('touchstart', this.mouseDownHandler);
        }

    }

    /**
     * @method create
     * @param {LatLng[]} latLngs
     * @param {Object} [options = { concavePolygon: false }]
     * @return {Object}
     */
    create(latLngs, options = { concavePolygon: false }) {
        const created = createFor(this.map, latLngs, { ...this.options, ...options });
        updateFor(this.map, 'create');
        return created;
    }

    /**
     * @method remove
     * @param {Object} polygon
     * @return {void}
     */
    remove(polygon) {
        polygon ? removeFor(this.map, polygon) : super.remove();
        updateFor(this.map, 'remove');
    }

    /**
     * @method clear
     * @return {void}
     */
    clear() {
        clearFor(this.map);
        updateFor(this.map, 'clear');
    }

    /**
     * @method setMode
     * @param {Number} [mode = null]
     * @return {Number}
     */
    mode(mode = null) {
        // Set mode when passed `mode` is numeric, and then yield the current mode.
        typeof mode === 'number' && modeFor(this.map, mode, this.options);
        return this.map[modesKey];
    }

    /**
     * @method size
     * @return {Number}
     */
    size() {
        return polygons.get(this.map).size;
    }

    /**
     * @method all
     * @return {Array}
     */
    all() {
        return Array.from(polygons.get(this.map));
    }

    /**
     * @method cancel
     * @return {void}
     */
    cancel() {
        this.map[cancelKey]();
    }

    _simulateEvent(type, e) {
        var simulatedEvent = document.createEvent('MouseEvents');

		simulatedEvent._simulated = true;
		e.target._simulatedClick = true;

		simulatedEvent.initMouseEvent(
		        type, true, true, window, 1,
		        e.screenX, e.screenY,
		        e.clientX, e.clientY,
		        false, false, false, false, 0, null);

		e.target.dispatchEvent(simulatedEvent);
    }


    /**
     * @method listenForEvents
     * @param {Object} map
     * @param {Object} svg
     * @param {Object} options
     * @return {void}
     */
    listenForEvents(map, svg, options) {
        let latLngs = new Set();
        let lineIterator;

        /**
         * @method mouseMove
         * @param {Object} event
         * @return {void}
         */
        const mouseMove = (event) => {
            // const x = performance.now();
            // console.log('mouseMove');

            // Resolve the pixel point to the latitudinal and longitudinal equivalent.
            let e = event.originalEvent || event;
            if (e.touches) {
                e = e.touches[0];
            }

            const point = map.mouseEventToContainerPoint(e);

            // Push each lat/lng value into the points set.
            latLngs.add(map.containerPointToLatLng(point));

            // Invoke the generator by passing in the starting point for the path.
            const svgpoint = new Point(point.x, point.y);
            lineIterator(svgpoint);
            
            // const y = performance.now();
            // console.log('mouseMoveEnd: ' + (y-x).toString());
        };

        /**
         * @method mouseUp
         * @param {Boolean} [create = true]
         * @return {Function}
         */
        const mouseUp = (event, create = true) => {
            // Ignore pointer cancel events (touch interfaces fire these randomly)
            if (event.type === 'pointercancel') {
                return;
            }

            // const x = performance.now();
            // console.log('mouseup');

            // Remove the ability to invoke `cancel`.
            map[cancelKey] = () => {};

            // Stop listening to the events.
            map.off('mouseup', mouseUp);
            map.off('mousemove', mouseMove);
            DomEvent.off(this.map._container, 'touchmove', mouseMove, this);
            DomEvent.off(this.map._container, 'touchend', mouseUp, this);

            'body' in document && document.body.removeEventListener('mouseleave', mouseUp);

            // Clear the SVG canvas.
            svg.selectAll('*').remove();

            if (create) {

                // ...And finally if we have any lat/lngs in our set then we can attempt to
                // create the polygon.
                latLngs.size && createFor(map, Array.from(latLngs), options);

                // Finally invoke the callback for the polygon regions.
                updateFor(map, 'create');

                // Exit the `CREATE` mode if the options permit it.
                options.leaveModeAfterCreate && this.mode(this.mode() ^ CREATE);

            }

            // const y = performance.now();
            // console.log('mouseupEnd: ' + (y-x).toString());
        };

        const touchStart = (event) => {
            if (!(map[modesKey] & CREATE)) {
                // Polygons can only be created when the mode includes create.
                return;
            }
           
            DomEvent.preventDefault(event);

            DomEvent.on(this.map._container, 'touchmove', mouseMove, this);
            DomEvent.on(this.map._container, 'touchend', mouseUp, this);

            this._simulateEvent('mousedown', event)
        }

        /**
         * @method mouseDown
         * @param {Object} event
         * @return {void}
         */
        const mouseDown = (event) => {
            // const x = performance.now();
            // console.log('mousedown');
            
            DomEvent.preventDefault(event);

            if (!(map[modesKey] & CREATE)) {
                // Polygons can only be created when the mode includes create.
                return;
            }

            // Depending on leaflet version and plugins the touchstart event can fire a mousedown event with coords 0,0
            // if that happens... just ignore it
            if (event.clientX === 0 && event.clientY === 0) {
                return;
            }

            /**
             * @constant latLngs
             * @type {Set}
             */
            latLngs = new Set();
            lineIterator = undefined;

            if (!!event.latlng) {
                // Create the line iterator and move it to its first `yield` point, passing in the start point
                // from the mouse down event.
                const point = map.latLngToContainerPoint(event.latlng);
                lineIterator = this.createPath(svg, point, options.strokeWidth);
            } else {
                const point = map.mouseEventToContainerPoint(event);
                lineIterator = this.createPath(svg, point, options.strokeWidth);
            }
            

            // if we are not a touch interface register mouse events
            if (!event.touches) {
                map.on('mousemove', mouseMove);
                map.on('mouseup', mouseUp);
            }

            'body' in document && document.body.addEventListener('mouseleave', mouseUp);

            // Setup the function to invoke when `cancel` has been invoked.
            map[cancelKey] = () => mouseUp({}, false);

            // const y = performance.now();
            // console.log('mousedownEnd: ' + (y-x).toString());
        };

        this.mouseDownHandler = mouseDown;
        DomEvent.on(map._container, 'mousedown', mouseDown, this);
        DomEvent.on(map._container, 'touchstart', touchStart, this);
    }

    /**
     * @method createPath
     * @param {Object} svg
     * @param {Point} fromPoint
     * @param {Number} strokeWidth
     * @return {void}
     */
    createPath(svg, fromPoint, strokeWidth) {
        let lastPoint = fromPoint;

        const lineFunction = line().curve(curveMonotoneX).x(d => d.x).y(d => d.y);

        return toPoint => {
            const lineData = [ lastPoint, toPoint ];
            lastPoint = toPoint;
            // Draw SVG line based on the last movement of the mouse's position.
            svg.append('path')
                .classed(this.options.lineclass || 'leaflet-line', true)
                .attr('d', lineFunction(lineData))
                .attr('fill', this.options.fill || 'none')
                .attr('fill-opacity', this.options.fillOpacity || 1)
                .attr('stroke', this.options.stroke || 'black')
                .attr('stroke-width', strokeWidth);
        };
    }

}

/**
 * @method freeDraw
 * @return {Object}
 */
export const freeDraw = options => {
    return new FreeDraw(options);
};

export { CREATE, EDIT, DELETE, APPEND, EDIT_APPEND, NONE, ALL } from './helpers/Flags';

if (typeof window !== 'undefined') {

    // Attach to the `window` as `FreeDraw` if it exists, as this would prevent `new FreeDraw.default` when
    // using the web version.
    window.FreeDraw = FreeDraw;
    FreeDraw.CREATE = CREATE;
    FreeDraw.EDIT = EDIT;
    FreeDraw.DELETE = DELETE;
    FreeDraw.APPEND = APPEND;
    FreeDraw.EDIT_APPEND = EDIT_APPEND;
    FreeDraw.NONE = NONE;
    FreeDraw.ALL = ALL;

}