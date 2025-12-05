/*
 * SmartBIB: The SmartBIB Project allows you to present a BibTeX-based bibliography
 * on a web page. It is ideal for personal and project websites.
 *
 * Copyright (C) 2015 Data Management Systems Laboratory, University of Cyprus
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

$(document).ready(function () {
    // Initialize Isotope for the publication list
    var $container = $('.publication-list');

    // Initialize with these options
    $container.isotope({
        itemSelector: '.publication',
        layoutMode: 'vertical',
        getSortData: {
            year: function (itemElem) {
                return parseInt($(itemElem).attr('data-year'), 10);
            }
        },
        sortBy: 'year',
        sortAscending: false
    });

    // Filter items when filter link is clicked
    $('#publication-filter a').click(function () {
        var selector = $(this).attr('data-filter');
        $container.isotope({ filter: selector });

        // Update active filter class
        $('#publication-filter a').removeClass('current');
        $(this).addClass('current');

        return false;
    });

    // Initialize fancybox for BibTeX popups
    $('a.fancybox').fancybox({
        'hideOnContentClick': true,
        'width': 800,
        'height': 600,
        'autoScale': true,
        'type': 'inline'
    });

    // Initialize tooltip
    $('.tip').tipsy({
        gravity: 'w'
    });

    // Scroll to top functionality
    $(window).scroll(function () {
        if ($(this).scrollTop() > 200) {
            $('#topcontrol').fadeIn();
        } else {
            $('#topcontrol').fadeOut();
        }
    });

    $('#topcontrol').click(function () {
        $('html, body').animate({ scrollTop: 0 }, 800);
        return false;
    });
});
