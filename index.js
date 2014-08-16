'use strict';
var _ = require('lodash');
var Subscriber = require('emissary').Subscriber;
var jshint = require('jshint').JSHINT;
var jsxhint = require('jshint-jsx').JSXHINT;
var loadConfig = require('./load-config');
var plugin = module.exports;

var markersByEditorId = {};
var errorsByEditorId = {};

Subscriber.extend(plugin);

function getMarkersForEditor() {
	var editor = atom.workspace.getActiveEditor();

	if (editor && markersByEditorId[editor.id]) {
		return markersByEditorId[editor.id];
	}

	return {};
}

function clearOldMarkers(errors) {
	var rows = _.map(errors, function (error) {
		return getRowForError(error);
	});

	var oldMarkers = getMarkersForEditor();
	_.each(_.keys(oldMarkers), function (row) {
		if (!_.contains(rows, row)) {
			destroyMarkerAtRow(row);
		}
	});
}

function destroyMarkerAtRow(row) {
	var editor = atom.workspace.getActiveEditor();
	if (markersByEditorId[editor.id] && markersByEditorId[editor.id][row]) {
		markersByEditorId[editor.id][row].destroy();
		delete markersByEditorId[editor.id][row];
	}
}

function saveMarker(marker, row) {
	var editor = atom.workspace.getActiveEditor();

	if (!markersByEditorId[editor.id]) {
		markersByEditorId[editor.id] = {};
	}

	markersByEditorId[editor.id][row] = marker;
}

function getMarkerAtRow(row) {
	var editor = atom.workspace.getActiveEditor();

	if (!markersByEditorId[editor.id]) {
		return null;
	}

	return markersByEditorId[editor.id][row];
}

function updateStatusbar() {
	if (atom.workspaceView.statusBar) {
		var editor = atom.workspace.getActiveEditor();

		atom.workspaceView.statusBar.find('#jshint-statusbar').remove();

		if (!editor || !errorsByEditorId[editor.id]) {
			return;
		}

		var line = editor.getCursorBufferPosition().row+1;
		var error = errorsByEditorId[editor.id][line] || _.first(_.compact(errorsByEditorId[editor.id]));
		error = error[0];

		atom.workspaceView.statusBar.appendLeft('<span id="jshint-statusbar" class="inline-block">JSHint ' + error.line + ':' + error.character + ' ' + error.reason + '</span>');
	}
}

function getRowForError(error) {
	var line = error[0].line || 1; // JSHint reports `line: 0` when config error
	var row = line - 1;
	return row;
}

function displayError(error) {
	var row = getRowForError(error);

	if (getMarkerAtRow(row)) {
		return;
	}

	var editor = atom.workspace.getActiveEditor();
	var marker = editor.markBufferRange([[row, 0], [row, 1]]);
	editor.decorateMarker(marker, {type: 'line', class: 'jshint-line'});
	editor.decorateMarker(marker, {type: 'gutter', class: 'jshint-line-number'});
	saveMarker(marker, row);
	addReasons(marker, error);
}

function getReasonsForError(error) {
	return _.map(error, function (el) {
		return el.character + ': ' + el.reason;
	});
}

function addReasons(marker, error) {
	var row = getRowForError(error);
	var editorView = atom.workspaceView.getActiveView();
	var gutter = editorView.gutter;
	var reasons = '<div class="jshint-errors">' + getReasonsForError(error).join('<br />') + '</div>';
	var gutterRow = gutter.find(gutter.getLineNumberElement(row));

	gutterRow.destroyTooltip();
	gutterRow.setTooltip({title: reasons, placement: 'bottom', delay: {show: 200}});
	marker.on('changed destroyed', function () {
		gutterRow.destroyTooltip();
	});
}

function lint() {
	var editor = atom.workspace.getActiveEditor();

	if (!editor) {
		return;
	}

	if (['JavaScript', 'JavaScript (JSX)'].indexOf(editor.getGrammar().name) === -1) {
		return;
	}

	var file = editor.getUri();
	var config = file ? loadConfig(file) : {};

	var linter = (atom.config.get('jshint.supportLintingJsx') || atom.config.get('jshint.transformJsx')) ? jsxhint : jshint;
	linter(editor.getText(), config, config.globals);

	removeErrorsForEditorId(editor.id);

	// workaround the errors array sometimes containing `null`
	var errors = _.compact(linter.errors);

	if (errors.length > 0) {
		// aggregate same-line errors
		var ret = [];
		_.each(errors, function (el) {
			var l = el.line;

			if (Array.isArray(ret[l])) {
				ret[l].push(el);

				ret[l] = _.sortBy(ret[l], function (el) {
					return el.character;
				});
			} else {
				ret[l] = [el];
			}
		});

		errorsByEditorId[editor.id] = ret;
		errors = _.compact(ret);
	}

	displayErrors(errors);
}

function displayErrors(errors) {
	clearOldMarkers(errors);
	updateStatusbar();
	_.each(errors, displayError);
}

function removeMarkersForEditorId(id) {
	if (markersByEditorId[id]) {
		delete markersByEditorId[id];
	}
}

function removeErrorsForEditorId(id) {
	if (errorsByEditorId[id]) {
		delete errorsByEditorId[id];
	}
}

function registerEvents() {
	lint();

	atom.workspace.eachEditor(function (editor) {
		var buffer = editor.getBuffer();
		var events = 'saved contents-modified';

		editor.off('scroll-top-changed');
		plugin.unsubscribe(buffer);

		if (atom.config.get('jshint.validateOnlyOnSave')) {
			events = 'saved';
		} else {
			// TODO: find a less noisy event for this
			editor.on('scroll-top-changed', _.debounce(lint, 200));
		}

		plugin.subscribe(buffer, events, _.debounce(lint, 50));
	});

	atom.workspaceView.on('editor:will-be-removed', function (e, editorView) {
		if (editorView && editorView.editor) {
			removeErrorsForEditorId(editorView.editor.id);
			removeMarkersForEditorId(editorView.editor.id);
		}
	});

	atom.workspaceView.on('cursor:moved', function (e) {
		updateStatusbar();
	});
}

plugin.configDefaults = {
	validateOnlyOnSave: false,
	supportLintingJsx: false
};

plugin.activate = function () {
	registerEvents();
	plugin.subscribe(atom.config.observe('jshint.validateOnlyOnSave', registerEvents));
	atom.workspaceView.command('jshint:lint', lint);
};
