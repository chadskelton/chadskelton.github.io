var jqueryNoConflict = jQuery;

// begin main function - just copy entire published table
jqueryNoConflict(document).ready(function(){

    initializeTabletopObject('https://docs.google.com/spreadsheets/d/1HGliaWQ1Q0IvLi8AA4gZymttvf0USdfuAYqEmddHwec/pubhtml');

});

// pull data from google spreadsheet
function initializeTabletopObject(dataSpreadsheet){
    Tabletop.init({
        key: dataSpreadsheet,
        callback: writeTableWith,
        simpleSheet: true,
        debug: false
    });
}

// create table headers
function createTableColumns(){

    /* swap out the properties of mDataProp & sTitle to reflect
    the names of columns or keys you want to display.
    Remember, tabletop.js strips out spaces from column titles, which
    is what happens with the More Info column header 
	and turns them all into lowercase */

    var tableColumns =   [
		{'mDataProp': 'localhealtharea', 'sTitle': 'Health Area', 'sClass': 'center'},
		{'mDataProp': 'schoolname', 'sTitle': 'School Name', 'sClass': 'center'},
		{'mDataProp': 'hpv', 'sTitle': 'HPV Rate', 'sClass': 'center'},
		{'mDataProp': 'tdap', 'sTitle': 'Tetanus', 'sClass': 'center'},
	];
    return tableColumns;
}

// create the table container and object
function writeTableWith(dataSource){

    jqueryNoConflict('#demo').html('<table cellpadding="0" cellspacing="0" border="0" class="display table table-bordered table-striped" id="data-table-container"></table>');

    var oTable = jqueryNoConflict('#data-table-container').dataTable({
		'sPaginationType': 'bootstrap',
		'iDisplayLength': 25,
        'aaData': dataSource,
        'aoColumns': createTableColumns(),
        'oLanguage': {
            'sLengthMenu': '_MENU_ records per page'
        }
    });
};

//define two custom functions (asc and desc) for string sorting
jQuery.fn.dataTableExt.oSort['string-case-asc']  = function(x,y) {
	return ((x < y) ? -1 : ((x > y) ?  0 : 0));
};

jQuery.fn.dataTableExt.oSort['string-case-desc'] = function(x,y) {
	return ((x < y) ?  1 : ((x > y) ? -1 : 0));
};